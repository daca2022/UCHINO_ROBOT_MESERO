/**
 * LlmBridgeRouter — Express router que expone endpoints REST para que el
 * módulo Python de diálogo se comunique con el orquestador LLM Node.js.
 *
 * Uso:
 *   import { createLlmBridgeRouter } from './interfaces/llmBridgeRouter.mjs';
 *   app.use('/api/llm', createLlmBridgeRouter(orchestrator, memoryService));
 *
 * @module interfaces/llmBridgeRouter
 */

import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { buildActiveHriContextBlock } from '../../../shared/hriContextRules.mjs';
import { sanitizeForSpeech, speechPayload } from '../application/SpeechTextSanitizer.mjs';
import { JWT_SECRET } from '../config/adminSecurity.mjs';

const RATE_LIMIT_MAX = 10;           // requests per second per IP
const RATE_LIMIT_WINDOW_MS = 1000;    // sliding window (1 second)
const CLEANUP_INTERVAL_MS = 5000;     // cada 5s limpia entradas expiradas
const PROTECTED_ORDER_FIELDS = Object.freeze([
    'is_test', 'data_origin', 'retention_class', 'archived_at', 'archived_by',
    'archive_reason', 'deleted_at', 'deletion_reason', 'created_at', 'updated_at',
    'confirmed_at', 'delivered_at', 'cancelled_at', 'id', 'order_id',
]);
const INTERNAL_LLM_TOKEN = String(process.env.LLM_BRIDGE_TOKEN || JWT_SECRET || '');

function hasInternalLlmToken(req) {
    const supplied = String(req.get('x-internal-token') || '');
    if (!INTERNAL_LLM_TOKEN || !supplied) return false;
    const expected = Buffer.from(INTERNAL_LLM_TOKEN);
    const actual = Buffer.from(supplied);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function buildSystemPromptWithMemory(profileId, mesa, memoryService, temporaryMemoryService, context = {}) {
    if (!memoryService || !temporaryMemoryService || !profileId || !context.sessionId) return null;
    try {
        const memory = await temporaryMemoryService.summary({ sessionId: context.sessionId, profileId });
        const memoryParts = [];
        if (memory.name) memoryParts.push(`nombre declarado: ${memory.name}`);
        if (memory.preferences.length) memoryParts.push(`preferencias declaradas: ${memory.preferences.join(', ')}`);
        if (memory.companions.length) memoryParts.push(`acompañantes declarados: ${memory.companions.join(', ')}`);
        const histTxt = memory.last_order?.items?.length
            ? `Último pedido confirmado recuperable: ${memory.last_order.items.map(item => `${item.nombre} x${item.cantidad}`).join(', ')}.`
            : '';
        const memoryTxt = memoryParts.length ? `Memoria temporal consentida: ${memoryParts.join('; ')}.` : '';
        const mesaTxt = mesa ? `Mesa actual: ${mesa}.` : '';
        const hriBlock = buildActiveHriContextBlock({}, context);

        // Cargar menú real para que el LLM pueda resolver nombres y precios exactos.
        const menu = await memoryService.obtenerMenu().catch(() => []);
        const menuTxt = menu.length > 0
            ? `\n\nMENÚ DISPONIBLE (usa estos nombres y precios EXACTOS al registrar_pedido):\n${menu.map(m => `- ${m.nombre} (S/. ${Number(m.precio).toFixed(2)})`).join('\n')}`
            : '';

        return `Eres Uchino, robot mesero de una cafetería peruana en UTEC. Jerga peruana: causa, pata, pe, al toque, chevere. Breve y claro. Máximo 1-2 jergas por respuesta. Responde en español.${memoryTxt ? ' ' + memoryTxt : ''}${histTxt ? ' ' + histTxt : ''}${mesaTxt ? ' ' + mesaTxt : ''}${menuTxt}

MEMORIA Y PRIVACIDAD: no inventes recuerdos ni identidades. El nombre, mesa y preferencias solo son contexto explicable de esta sesión. No apliques preferencias culinarias automáticamente; ofrécelas y pregunta. Una alergia recuperada requiere confirmación explícita en esta sesión. Las consultas de memoria no mutan el pedido y no debes llamar registrar_pedido por ellas.

REGLA CRÍTICA: Cuando el cliente pida productos del menú, SIEMPRE debes llamar a la función registrar_pedido con:
- mesa: "${mesa || '1'}"
- platos: array de {nombre: <exacto del menú>, cantidad: int >= 1, precio: <del menú>}
- bebida: nombre si pidió bebida
- total: suma de precio*cantidad
NUNCA digas "listo" sin haber llamado a registrar_pedido. Usa solo datos de memoria temporal con consentimiento explícito.${hriBlock}`;
    } catch (e) {
        return null;
    }
}

/**
 * Crea un router Express con las rutas del LLM Bridge.
 *
 * @param {object} llmOrchestrator - Instancia de LlmOrchestrator
 * @param {object} [memoryService] - Servicio de memoria (opcional, reservado)
 * @returns {import('express').Router}
 */
export function createLlmBridgeRouter(llmOrchestrator, memoryService, temporaryMemoryService = null, getSessionLifecycle = () => null) {
    const router = Router();

    function authorizeMemoryContext(req, res, { profileId, sessionId } = {}) {
        if (!profileId) return true;
        if (!sessionId) {
            res.status(400).json({ error: 'sessionId es obligatorio para usar memoria personal.', code: 'ORDER_SESSION_REQUIRED' });
            return false;
        }
        if (hasInternalLlmToken(req)) return true;
        const lifecycle = typeof getSessionLifecycle === 'function' ? getSessionLifecycle() : getSessionLifecycle;
        const session = lifecycle?.get?.(String(sessionId));
        const suppliedToken = String(req.get('x-session-token') || '');
        if (!session?.session_access_token || suppliedToken !== session.session_access_token) {
            res.status(401).json({ error: 'Token de sesión requerido para memoria personal.', code: 'SESSION_ACCESS_REQUIRED' });
            return false;
        }
        return true;
    }

    // ── Rate limiter: sliding window por IP ─────────────
    /** @type {Map<string, number[]>} */
    const requestTimestamps = new Map();

    function rateLimitMiddleware(req, res, next) {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        const now = Date.now();

        if (!requestTimestamps.has(ip)) {
            requestTimestamps.set(ip, []);
        }

        const timestamps = requestTimestamps.get(ip);
        // Keep only requests within the current window
        const valid = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);

        if (valid.length >= RATE_LIMIT_MAX) {
            return res.status(429).json({
                error: 'Too many requests',
                retryAfter: 1,
            });
        }

        valid.push(now);
        requestTimestamps.set(ip, valid);
        next();
    }

    // Periodic cleanup to prevent memory leaks
    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [ip, timestamps] of requestTimestamps) {
            const valid = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
            if (valid.length === 0) {
                requestTimestamps.delete(ip);
            } else {
                requestTimestamps.set(ip, valid);
            }
        }
    }, CLEANUP_INTERVAL_MS);

    // Allow the timer to not prevent Node.js exit
    if (cleanupTimer.unref) {
        cleanupTimer.unref();
    }

    // ── CORS ────────────────────────────────────────────
    router.use((req, res, next) => {
        const origin = String(req.get('origin') || '');
        const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3005,http://127.0.0.1:3005,http://localhost:5173,http://127.0.0.1:5173')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean);
        if (origin && allowedOrigins.includes(origin)) res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, X-Internal-Token');
        if (req.method === 'OPTIONS') {
            return res.sendStatus(200);
        }
        next();
    });

    // Apply rate limiter to all routes
    router.use(rateLimitMiddleware);

    // ── GET /api/llm/health ─────────────────────────────
    router.get('/health', async (_req, res) => {
        try {
            const providers = [];

            // Active provider
            const activeInfo = llmOrchestrator.active?.getModelInfo?.();
            providers.push({
                name: activeInfo?.name || 'unknown',
                status: 'active',
            });

            // Primary provider (may differ from active if on fallback)
            if (llmOrchestrator.primary && llmOrchestrator.primary !== llmOrchestrator.active) {
                const primaryInfo = llmOrchestrator.primary.getModelInfo?.();
                providers.push({
                    name: primaryInfo?.name || 'primary',
                    status: llmOrchestrator.onFallback ? 'degraded' : 'active',
                });
            }

            // Fallback provider
            if (llmOrchestrator.fallback) {
                const fallbackInfo = llmOrchestrator.fallback.getModelInfo?.();
                providers.push({
                    name: fallbackInfo?.name || 'fallback',
                    status: llmOrchestrator.onFallback ? 'active' : 'standby',
                });
            }

            res.json({
                providers,
                active: activeInfo?.name || 'unknown',
                onFallback: !!llmOrchestrator.onFallback,
                uptime: process.uptime(),
            });
        } catch (err) {
            res.status(503).json({
                error: 'LLM not initialized',
                status: 'down',
            });
        }
    });

    // ── POST /api/llm/chat ──────────────────────────────
    router.post('/chat', async (req, res) => {
        const { message, provider, history, emotion, messages, profileId, sessionId, mesa } = req.body;

        if (!message && (!messages || messages.length === 0)) {
            return res.status(400).json({ error: 'message or messages is required' });
        }
        if (!authorizeMemoryContext(req, res, { profileId, sessionId })) return;

        try {
            let result;
            if (Array.isArray(messages) && messages.length > 0) {
                if (profileId && sessionId) {
                    const systemMsg = await buildSystemPromptWithMemory(profileId, mesa, memoryService, temporaryMemoryService, { text: message, sessionId });
                    if (systemMsg) {
                        messages.unshift({ role: 'system', content: systemMsg });
                    }
                }
                result = await llmOrchestrator.processWithMessages(messages);
            } else {
                if (profileId && sessionId) {
                    const systemMsg = await buildSystemPromptWithMemory(profileId, mesa, memoryService, temporaryMemoryService, { text: message, sessionId });
                    if (systemMsg) {
                        result = await llmOrchestrator.processWithMessages([
                            { role: 'system', content: systemMsg },
                            { role: 'user', content: message },
                        ]);
                    } else {
                        result = await llmOrchestrator.processText(message);
                    }
                } else {
                    result = await llmOrchestrator.processText(message);
                }
            }

            const prepared = sanitizeForSpeech(result.text || '', {
                source: 'llm_bridge_chat',
                sessionId,
                mesa,
            });
            res.json({
                text: prepared.displayText,
                ...speechPayload(prepared),
                functionCalls: (result.actions || []).map(a => ({
                    name: a.name,
                    args: a.args,
                })),
                provider: llmOrchestrator.active?.getModelInfo?.()?.name || 'unknown',
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── POST /api/llm/dialogue ──────────────────────────
    router.post('/dialogue', async (req, res) => {
        const { state, input: inputText, sessionId, mesa, profileId } = req.body;

        if (!state || !inputText) {
            return res.status(400).json({
                error: 'state and input are required',
            });
        }
        if (!authorizeMemoryContext(req, res, { profileId, sessionId })) return;

        try {
            const contextMessage = `[STATE: ${state}] ${inputText}`;
            let result;
            const systemMsg = await buildSystemPromptWithMemory(
                profileId, mesa, memoryService, temporaryMemoryService, { text: inputText, sessionId }
            ).catch(() => null);
            if (systemMsg) {
                result = await llmOrchestrator.processWithMessages([
                    { role: 'system', content: systemMsg },
                    { role: 'user', content: contextMessage },
                ]);
            } else {
                result = await llmOrchestrator.processText(contextMessage);
            }

            const emotionCall = (result.actions || []).find(
                a => a.name === 'expresar_emocion'
            );
            const emotion = emotionCall?.args?.emocion || null;

            const text = result.text || '';
            const prepared = sanitizeForSpeech(text, {
                source: 'llm_bridge_dialogue',
                sessionId,
                mesa,
            });
            let newState = state;
            if (text.toLowerCase().includes('pedido') || text.toLowerCase().includes('orden')) {
                newState = 'procesando_pedido';
            } else if (text.toLowerCase().includes('cuenta') || text.toLowerCase().includes('pagar')) {
                newState = 'cerrando_cuenta';
            } else if (text.toLowerCase().includes('gracias') || text.toLowerCase().includes('chau')) {
                newState = 'despidiendo';
            }

            res.json({
                response: prepared.displayText,
                display_text: prepared.displayText,
                speech_text: prepared.speechText,
                speech_segments: prepared.segments,
                sanitization: prepared.metadata,
                newState,
                emotion,
                functionCalls: (result.actions || []).map(a => ({
                    name: a.name,
                    args: a.args,
                })),
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── POST /api/llm/function-call ─────────────────────
    router.post('/function-call', async (req, res) => {
        if (!hasInternalLlmToken(req)) {
            return res.status(401).json({ error: 'Token interno requerido.', code: 'INTERNAL_AUTH_REQUIRED' });
        }
        const { name, args, sessionId } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'name is required' });
        }

        try {
            const handler = llmOrchestrator.handlers[name];
            if (!handler) {
                return res.status(404).json({
                    error: `Handler not found: ${name}`,
                });
            }

            const safeArgs = { ...(args && typeof args === 'object' ? args : {}) };
            if (name === 'registrar_pedido') {
                const requestedSession = String(sessionId || '').trim();
                if (!requestedSession || requestedSession.length > 160) {
                    return res.status(400).json({ error: 'sessionId es obligatorio para registrar un pedido', code: 'ORDER_SESSION_REQUIRED' });
                }
                if (safeArgs.session_id && String(safeArgs.session_id) !== requestedSession) {
                    return res.status(409).json({ error: 'sessionId no coincide con el pedido', code: 'SESSION_MISMATCH' });
                }
                for (const field of PROTECTED_ORDER_FIELDS) delete safeArgs[field];
                safeArgs.session_id = requestedSession;
            }

            const result = await Promise.resolve(handler(safeArgs));

            res.json({
                success: true,
                result,
                name,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    return router;
}
