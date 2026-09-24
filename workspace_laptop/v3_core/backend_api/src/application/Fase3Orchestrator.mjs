/**
 * Fase3Orchestrator.mjs — FASE 3: LLM Pagado Real
 *
 * Orquesta el flujo ASR final → OpenRouter (modelo pagado) → respuesta textual
 * + acciones estructuradas.
 *
 * Reglas:
 * - Rechaza modelos cuyo ID contenga ":free", "free" o proveedores locales.
 * - Loggea: provider, model, paid, HTTP status, latency, fallback, motivo.
 * - Si el modelo pagado falla → error explícito (no mock, no fake).
 * - No hardcodea API keys.
 */

import { SYSTEM_PROMPT_BASE, buildSystemPrompt } from '../config/systemPrompt.mjs';

// ─── Menú real de la Cafetería UTEC ───────────────────────────────
const MENU_REAL = [
    { nombre: 'Café pasado',        precio: 5.00,  categoria: 'bebidas',  descripcion: 'Café filtrado tradicional peruano' },
    { nombre: 'Americano',           precio: 6.00,  categoria: 'bebidas',  descripcion: 'Café americano' },
    { nombre: 'Expreso',             precio: 5.00,  categoria: 'bebidas',  descripcion: 'Café expreso' },
    { nombre: 'Capuchino',           precio: 7.00,  categoria: 'bebidas',  descripcion: 'Café capuchino con espuma de leche' },
    { nombre: 'Empanada de pollo',   precio: 4.00,  categoria: 'comidas',  descripcion: 'Empanada de pollo peruana' },
    { nombre: 'Empanada de queso',   precio: 4.00,  categoria: 'comidas',  descripcion: 'Empanada de queso' },
    { nombre: 'Sánguche de pollo',   precio: 8.00,  categoria: 'comidas',  descripcion: 'Sánguche de pollo con palta' },
    { nombre: 'Sánguche de jamón',   precio: 7.00,  categoria: 'comidas',  descripcion: 'Sánguche de jamón del país' },
    { nombre: 'Sánguche de palta',   precio: 6.00,  categoria: 'comidas',  descripcion: 'Sánguche de palta (aguacate)' },
    { nombre: 'Jugo de naranja',     precio: 5.00,  categoria: 'bebidas',  descripcion: 'Jugo natural de naranja' },
    { nombre: 'Jugo de maracuyá',    precio: 5.00,  categoria: 'bebidas',  descripcion: 'Jugo natural de maracuyá' },
    { nombre: 'Jugo de fresa',       precio: 6.00,  categoria: 'bebidas',  descripcion: 'Jugo natural de fresa' },
    { nombre: 'Tres leches',         precio: 7.00,  categoria: 'postres',  descripcion: 'Pastel tres leches' },
    { nombre: 'Suspiro limeño',      precio: 6.00,  categoria: 'postres',  descripcion: 'Suspiro limeño tradicional' },
    { nombre: 'Alfajor',             precio: 3.00,  categoria: 'postres',  descripcion: 'Alfajor peruano de manjar blanco' },
    { nombre: 'Chicha morada',       precio: 4.00,  categoria: 'bebidas',  descripcion: 'Chicha morada tradicional' },
    { nombre: 'Inca Kola',           precio: 3.00,  categoria: 'bebidas',  descripcion: 'Gaseosa Inca Kola 500ml' },
    { nombre: 'Agua mineral',        precio: 2.00,  categoria: 'bebidas',  descripcion: 'Agua mineral sin gas 500ml' },
    { nombre: 'Lomo saltado',        precio: 14.00, categoria: 'comidas',  descripcion: 'Lomo saltado con papas fritas y arroz' },
    { nombre: 'Ceviche',             precio: 12.00, categoria: 'comidas',  descripcion: 'Ceviche peruano con camote y canchita' },
    { nombre: 'Tallarines verdes',   precio: 10.00, categoria: 'comidas',  descripcion: 'Tallarines verdes con bistec' },
];

// ─── Tools / Function Calling ─────────────────────────────────────
const FUNCTION_TOOLS = [{
    type: 'function',
    function: {
        name: 'registrar_pedido',
        description: 'Registra el pedido provisional del cliente. Llama a esta función ANTES de responder con texto.',
        parameters: {
            type: 'object',
            properties: {
                mesa: { type: 'string', description: 'Número de mesa del cliente' },
                platos: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            nombre: { type: 'string', description: 'Nombre EXACTO del producto del menú' },
                            cantidad: { type: 'integer', description: 'Cantidad (default 1)' },
                            precio: { type: 'number', description: 'Precio unitario del menú' },
                        },
                        required: ['nombre', 'cantidad', 'precio'],
                    },
                },
                bebida: { type: 'string', description: 'Nombre de bebida si el cliente pidió bebida explícita' },
                total: { type: 'number', description: 'Suma de precio * cantidad' },
            },
            required: ['platos'],
        },
    },
}];

// ─── Constantes de validación ─────────────────────────────────────
const FREE_MODEL_PATTERNS = [
    /:free$/i,
    /(^|\/)(free|local|ollama|mock)(\/|$)/i,
];
const LOCAL_PROVIDERS = ['ollama', 'localhost', '127.0.0.1'];

// ─── Modelos pagados conocidos en OpenRouter ──────────────────────
// No es una validación definitiva (se verifica contra API), pero filtra
// groseramente modelos gratuitos conocidos.
const KNOWN_FREE_MODELS = [
    'gpt-4o-mini:free',
];

// ─── Logger ───────────────────────────────────────────────────────
function makeLogger(sessionId) {
    const prefix = sessionId ? `[FASE3:${sessionId}]` : '[FASE3]';
    return {
        info: (msg, data) => {
            const extra = data ? ` ${JSON.stringify(data)}` : '';
            console.log(`${new Date().toISOString()} ${prefix} [INFO] ${msg}${extra}`);
        },
        warn: (msg, data) => {
            const extra = data ? ` ${JSON.stringify(data)}` : '';
            console.warn(`${new Date().toISOString()} ${prefix} [WARN] ${msg}${extra}`);
        },
        error: (msg, data) => {
            const extra = data ? ` ${JSON.stringify(data)}` : '';
            console.error(`${new Date().toISOString()} ${prefix} [ERROR] ${msg}${extra}`);
        },
        debug: (msg, data) => {
            const extra = data ? ` ${JSON.stringify(data)}` : '';
            console.error(`${new Date().toISOString()} ${prefix} [DEBUG] ${msg}${extra}`);
        },
    };
}

// ─── Validación de modelo ─────────────────────────────────────────
function validateModelId(modelId) {
    const errors = [];

    // 1. Verificar patrones de free
    for (const pattern of FREE_MODEL_PATTERNS) {
        if (pattern.test(modelId)) {
            errors.push(`Model ID '${modelId}' contiene patrón prohibido: ${pattern}`);
        }
    }

    // 2. Verificar modelos gratuitos conocidos
    for (const freeModel of KNOWN_FREE_MODELS) {
        if (modelId.toLowerCase() === freeModel.toLowerCase()) {
            errors.push(`Model ID '${modelId}' es un modelo gratuito conocido: ${freeModel}`);
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        modelId,
        isFree: !(errors.length === 0),
    };
}

// ─── Verificación contra API de OpenRouter ────────────────────────
async function verifyModelIsPaid(modelId, apiKey, baseUrl) {
    const logger = makeLogger('verify');
    try {
        const url = `${baseUrl}/models`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
            logger.warn(`No se pudo verificar modelo contra API (HTTP ${response.status})`);
            return { verified: false, reason: `HTTP ${response.status}` };
        }

        const data = await response.json();
        const models = data?.data || [];
        const modelInfo = models.find(m => m.id === modelId);

        if (!modelInfo) {
            logger.warn(`Modelo '${modelId}' no encontrado en catálogo OpenRouter`);
            return { verified: false, reason: 'model_not_found' };
        }

        const pricing = modelInfo.pricing || {};
        const promptPrice = parseFloat(pricing.prompt) || 0;
        const completionPrice = parseFloat(pricing.completion) || 0;
        const isPaid = promptPrice > 0 || completionPrice > 0;

        return {
            verified: true,
            isPaid,
            promptPrice,
            completionPrice,
            modelId,
        };
    } catch (err) {
        logger.warn(`Error verificando modelo contra API: ${err.message}`);
        return { verified: false, reason: err.message };
    }
}

// ─── Construcción del system prompt con menú real ─────────────────
function buildFase3SystemPrompt(menu = MENU_REAL) {
    const menuBlock = menu.length > 0
        ? `

## Menú disponible (usar nombres y precios EXACTOS al registrar pedidos)

${menu.map(m => `- ${m.nombre} (S/. ${Number(m.precio).toFixed(2)}) [${m.categoria}]${m.descripcion ? ' — ' + m.descripcion : ''}`).join('\n')}

Cuando el cliente mencione un producto, busca el match en este menú y usa el nombre EXACTO en registrar_pedido.platos[].nombre.`
        : '';

    return `${SYSTEM_PROMPT_BASE}${menuBlock}

## Regla crítica
- SIEMPRE que el cliente mencione productos del menú, llama a registrar_pedido ANTES de responder.
- Usa los nombres y precios EXACTOS del menú de arriba.
- Si el cliente pide un producto que NO está en el menú, responde cortésmente que no está disponible.
- No inventes productos ni precios.`;
}

// ─── Llamada a OpenRouter (modelo pagado) ─────────────────────────
async function callPaidLLM(messages, tools, modelId, apiKey, baseUrl, logger, timeoutMs = 20000) {
    const url = `${baseUrl}/chat/completions`;
    const startTime = Date.now();

    const body = {
        model: modelId,
        messages,
        tools,
        temperature: 0.3,
        max_tokens: 300,
        stream: false,
    };

    logger.info('OPENROUTER_REQUEST', {
        model: modelId,
        url: url.replace(apiKey, '***'),
        messages_count: messages.length,
        tools_count: tools?.length || 0,
    });

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });

    const latencyMs = Date.now() - startTime;

    logger.info('OPENROUTER_RESPONSE', {
        status: response.status,
        ok: response.ok,
        latency_ms: latencyMs,
        model: modelId,
    });

    if (!response.ok) {
        const errBody = await response.text().catch(() => 'unknown');
        const errMsg = `OpenRouter HTTP ${response.status}: ${errBody.slice(0, 500)}`;
        logger.error(errMsg);
        throw new Error(errMsg);
    }

    const data = await response.json();

    const responseModel = data?.model || modelId;
    const choice = data?.choices?.[0];
    const message = choice?.message || {};
    const finishReason = choice?.finish_reason || 'unknown';

    logger.info('OPENROUTER_RESULT', {
        response_model: responseModel,
        finish_reason: finishReason,
        latency_ms: latencyMs,
        content_length: (message.content || '').length,
        tool_calls: message.tool_calls?.length || 0,
    });

    const result = {
        text: message.content || '',
        functionCalls: [],
        model: responseModel,
        latencyMs,
        finishReason,
    };

    if (message.tool_calls?.length > 0) {
        result.functionCalls = message.tool_calls.map(tc => {
            const fn = tc.function || {};
            let args = {};
            try {
                args = JSON.parse(fn.arguments || '{}');
            } catch {
                args = {};
            }
            return { name: fn.name, args };
        });
    }

    return result;
}

// ─── Orquestador principal ────────────────────────────────────────
export class Fase3Orchestrator {
    constructor({
        apiKey = process.env.OPENROUTER_API_KEY,
        baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
        model = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash',
        fallbackModel = process.env.OPENROUTER_FALLBACK_MODEL || null,
        menu = MENU_REAL,
        memoryService = null,
        timeoutMs = 20000,
    } = {}) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.modelId = model;
        this.fallbackModelId = fallbackModel;
        this.menu = menu;
        this._memoryService = memoryService;
        this._menuSource = menu && menu !== MENU_REAL ? 'param' : 'hardcoded';
        this.timeoutMs = timeoutMs;
        this.systemPrompt = buildFase3SystemPrompt(menu);
        this.onFallback = false;
        this.lastCall = null;
    }

    async refreshMenu() {
        if (!this._memoryService?.obtenerMenu) return;
        try {
            if (this._memoryService?.cache?.del) {
                await this._memoryService.cache.del('menu:del_dia').catch(() => {});
            }
            const items = await this._memoryService.obtenerMenu();
            if (Array.isArray(items) && items.length > 0) {
                this.menu = items.map(i => ({
                    id: i.id,
                    nombre: i.nombre,
                    precio: Number(i.precio),
                    categoria: i.categoria,
                    disponible: i.disponible !== false,
                    descripcion: i.descripcion || '',
                }));
                this.systemPrompt = buildFase3SystemPrompt(this.menu);
                this._menuSource = 'db';
                console.log(`[Fase3Orchestrator] Menú refrescado: ${this.menu.length} items desde DB`);
            }
        } catch (err) {
            console.warn('[Fase3Orchestrator] No se pudo recargar menú desde DB:', err.message);
        }
    }

    getMenuSource() {
        return this._menuSource;
    }

    /**
     * Valida que el modelo configurado esté permitido (no free).
     * @returns {{ valid: boolean, errors: string[], modelId: string }}
     */
    validateConfig() {
        const validation = validateModelId(this.modelId);
        if (this.fallbackModelId) {
            const fbValidation = validateModelId(this.fallbackModelId);
            if (!fbValidation.valid) {
                validation.errors.push(...fbValidation.errors);
                validation.valid = false;
            }
        }
        if (!this.apiKey) {
            validation.errors.push('OPENROUTER_API_KEY no está configurada');
            validation.valid = false;
        }
        if (!this.baseUrl) {
            validation.errors.push('OPENROUTER_BASE_URL no está configurada');
            validation.valid = false;
        }
        return validation;
    }

    /**
     * Verifica contra la API de OpenRouter que el modelo sea pagado.
     */
    async verifyPaidModel() {
        return verifyModelIsPaid(this.modelId, this.apiKey, this.baseUrl);
    }

    /**
     * Procesa un mensaje de usuario a través del modelo pagado.
     *
     * @param {object} input
     * @param {string} input.user_text - Texto ASR final
     * @param {string} input.session_id - ID de sesión
     * @param {number} input.turn_id - Número de turno
     * @param {string} input.mesa - Mesa del cliente
     * @param {string} input.client_id - ID del cliente
     * @param {Array}  input.conversation_history - Historial [{role, content}]
     * @param {object} input.current_order - Pedido actual si existe
     * @returns {Promise<object>} { text, functionCalls, model, latencyMs, paid, logs }
     */
    async process(input) {
        const log = makeLogger(input.session_id || 'unknown');
        this.lastCall = { input, timestamp: new Date().toISOString() };
        const callLogs = [];

        function logAndCollect(level, msg, data) {
            log[level](msg, data);
            callLogs.push({ level, msg, data, ts: new Date().toISOString() });
        }

        // ── 1. Validar input ──────────────────────────────────────
        if (!input || !input.user_text) {
            const err = { error: 'user_text es requerido', code: 'MISSING_USER_TEXT' };
            logAndCollect('error', 'INPUT_ERROR', err);
            return { ...err, paid: false };
        }

        const userText = input.user_text.trim();
        logAndCollect('info', 'INPUT_RECEIVED', {
            user_text: userText,
            session_id: input.session_id,
            turn_id: input.turn_id,
            mesa: input.mesa,
            client_id: input.client_id,
            history_length: input.conversation_history?.length || 0,
        });

        // ── 2. Validar modelo pagado ──────────────────────────────
        const configCheck = this.validateConfig();
        if (!configCheck.valid) {
            logAndCollect('error', 'CONFIG_INVALID', { errors: configCheck.errors });
            return {
                error: `Configuración de LLM inválida: ${configCheck.errors.join('; ')}`,
                code: 'INVALID_CONFIG',
                paid: false,
                errors: configCheck.errors,
            };
        }

        // ── 3. Verificar modelo contra API ────────────────────────
        const paidCheck = await this.verifyPaidModel();
        logAndCollect('info', 'MODEL_VERIFICATION', paidCheck);

        if (paidCheck.verified && !paidCheck.isPaid) {
            const errMsg = `Modelo '${this.modelId}' NO es un modelo pagado (precio prompt=${
                paidCheck.promptPrice}, completion=${paidCheck.completionPrice})`;
            logAndCollect('error', 'MODEL_NOT_PAID', paidCheck);
            return {
                error: errMsg,
                code: 'MODEL_NOT_PAID',
                paid: false,
                model: this.modelId,
            };
        }

        // ── 4. Preparar mensajes ──────────────────────────────────
        const messages = [
            { role: 'system', content: this.systemPrompt },
        ];

        // Agregar historial (limitado a últimos 10 mensajes)
        const history = Array.isArray(input.conversation_history) ? input.conversation_history : [];
        const recentHistory = history.slice(-10);
        for (const h of recentHistory) {
            messages.push({ role: h.role || 'user', content: h.content });
        }

        // Agregar current_order como contexto adicional si existe
        let orderContext = '';
        if (input.current_order && Object.keys(input.current_order).length > 0) {
            orderContext = `\n\nPedido actual del cliente: ${JSON.stringify(input.current_order)}`;
        }

        // Agregar datos de sesión como contexto
        const sessionContext = `\n\n[Datos de sesión - NO incluir en respuesta]\nMesa: ${input.mesa || 'no especificada'}\nSesión: ${input.session_id || 'actual'}\nTurno: ${input.turn_id || 0}`;

        messages.push({ role: 'user', content: userText + sessionContext + orderContext });

        logAndCollect('debug', 'MESSAGES_PREPARED', {
            system_prompt_length: this.systemPrompt.length,
            history_messages: recentHistory.length,
            user_text: userText,
            has_order_context: !!orderContext,
        });

        // ── 5. Llamar al modelo pagado ────────────────────────────
        let primaryResult = null;
        let primaryError = null;

        try {
            primaryResult = await callPaidLLM(
                messages,
                FUNCTION_TOOLS,
                this.modelId,
                this.apiKey,
                this.baseUrl,
                log,
                this.timeoutMs
            );
            logAndCollect('info', 'PRIMARY_SUCCESS', {
                model: primaryResult.model,
                latency_ms: primaryResult.latencyMs,
                function_calls: primaryResult.functionCalls.length,
            });
        } catch (err) {
            primaryError = err.message;
            logAndCollect('error', 'PRIMARY_FAILED', {
                error: err.message,
                model: this.modelId,
            });
        }

        // ── 6. Fallback si primario falla ─────────────────────────
        if (primaryError && this.fallbackModelId) {
            const fbValidation = validateModelId(this.fallbackModelId);
            if (fbValidation.valid) {
                logAndCollect('warn', 'FALLBACK_ATTEMPT', {
                    from: this.modelId,
                    to: this.fallbackModelId,
                    reason: primaryError,
                });
                this.onFallback = true;
                try {
                    primaryResult = await callPaidLLM(
                        messages,
                        FUNCTION_TOOLS,
                        this.fallbackModelId,
                        this.apiKey,
                        this.baseUrl,
                        log,
                        this.timeoutMs
                    );
                    logAndCollect('info', 'FALLBACK_SUCCESS', {
                        model: primaryResult.model,
                        latency_ms: primaryResult.latencyMs,
                    });
                } catch (fbErr) {
                    logAndCollect('error', 'FALLBACK_FAILED', {
                        error: fbErr.message,
                        model: this.fallbackModelId,
                    });
                    return {
                        error: `LLM falló: primario='${this.modelId}', fallback='${this.fallbackModelId}'. Error primario: ${primaryError}. Error fallback: ${fbErr.message}`,
                        code: 'ALL_PROVIDERS_FAILED',
                        paid: true,
                        logs: callLogs,
                    };
                }
            } else {
                logAndCollect('error', 'FALLBACK_INVALID', {
                    model: this.fallbackModelId,
                    errors: fbValidation.errors,
                });
                return {
                    error: `LLM primario falló y fallback es inválido. Error: ${primaryError}`,
                    code: 'PRIMARY_FAILED_INVALID_FALLBACK',
                    paid: true,
                    logs: callLogs,
                };
            }
        } else if (primaryError && !this.fallbackModelId) {
            return {
                error: `LLM primario falló y no hay fallback configurado. Error: ${primaryError}`,
                code: 'PRIMARY_FAILED_NO_FALLBACK',
                paid: true,
                logs: callLogs,
            };
        }

        // ── 7. Devolver resultado con logs ────────────────────────
        const paidInfo = paidCheck.verified
            ? { prompt_price: paidCheck.promptPrice, completion_price: paidCheck.completionPrice }
            : { price_verified: false };

        return {
            text: primaryResult.text,
            functionCalls: primaryResult.functionCalls,
            model: primaryResult.model,
            latencyMs: primaryResult.latencyMs,
            paid: true,
            onFallback: this.onFallback,
            finishReason: primaryResult.finishReason,
            logs: callLogs,
            ...paidInfo,
        };
    }
}
