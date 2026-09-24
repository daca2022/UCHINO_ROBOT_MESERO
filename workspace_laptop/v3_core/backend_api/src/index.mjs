import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import * as http from 'http';
import net from 'net';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { writeFileSync as sniffWriteFileSync } from 'fs';
import jwt from 'jsonwebtoken';
import { LlmOrchestrator } from '../../llm_brain/src/index.mjs';
import { createServices, getServices } from './config/services.mjs';
import { createLlmBridgeRouter } from './interfaces/llmBridgeRouter.mjs';
import { createAdminRouter } from './routes/admin.mjs';
import { createAsrProcessRouter } from './routes/asrProcess.mjs';
import { createSessionsRouter } from './routes/sessions.mjs';
import { createTablesRouter } from './routes/tables.mjs';
import { createMemoryRouter } from './routes/memory.mjs';
import { createAdminMemoryRouter } from './routes/adminMemory.mjs';
import { createAdminHistoryRouter } from './routes/adminHistory.mjs';
import { createAdminAnalyticsRouter } from './routes/adminAnalytics.mjs';
import { SessionLifecycleService } from './application/SessionLifecycleService.mjs';
import { isStaleSession } from './application/SessionActivityPolicy.mjs';
import { Fase3Orchestrator } from './application/Fase3Orchestrator.mjs';
import { OrderSessionManager, normalizeMesa } from './application/OrderSessionManager.mjs';
import { LocalTtsPlayer } from './application/LocalTtsPlayer.mjs';
import { SpeechPlaybackService } from './application/SpeechPlaybackService.mjs';
import { sanitizeForSpeech, speechPayload } from './application/SpeechTextSanitizer.mjs';
import { buildSystemPrompt } from './config/systemPrompt.mjs';
import { classifyIntent, Intent } from './application/IntentClassifier.mjs';
import {
    buildAudioFrame,
    downmixStereoPcm16ToMono,
    MAX_FRAME_PAYLOAD_BYTES,
    TYPE_PCM_MONO,
    TYPE_PCM_STEREO,
    wavToPcm16Mono16k,
    createAudioCleaner,
} from './application/AudioFrameUtils.mjs';
import { routeVoiceTurn, RouteFamily } from './application/HybridVoiceRouter.mjs';
import { RobotStateManager, RobotState, ROBOT_STATE_LABELS, ROBOT_STATE_COLORS } from './application/RobotStateManager.mjs';
import { TurnManager } from './application/TurnManager.mjs';
import { ProactiveMessageService, ProactiveEventType } from './application/ProactiveMessageService.mjs';
import { projectKitchenOrder, projectPublicTableAvailability } from './application/TableVisitService.mjs';
import { projectUiEvent } from './application/UiEventProjection.mjs';
import { adminAuth } from './middleware/adminAuth.mjs';
import { JWT_SECRET } from './config/adminSecurity.mjs';
import { bindCustomerOrderToSession, isAdminOrderMode } from './application/OrderRequestPolicy.mjs';
import { AnalyticsService } from './application/AnalyticsService.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:8100';
const AUDIO_LAB_ISOLATE_ESP32_PCM = ['1', 'true', 'yes'].includes(
    String(process.env.AUDIO_LAB_ISOLATE_ESP32_PCM || '').toLowerCase()
);
const AUDIO_LAB_TCP_PORT = Number(process.env.AUDIO_LAB_TCP_PORT || 3011);

/**
 * Llama al sidecar Python MasterOrchestrator y retorna la respuesta completa.
 * Retorna null si el sidecar no está disponible.
 */
async function tryOrchestrator(text, sessionId, metadata = {}) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

        const resp = await fetch(`${ORCHESTRATOR_URL}/orchestrate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text,
                session_id: sessionId,
                metadata: { ...metadata, tts_deferred: true },
            }),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            console.error(`[ORCHESTRATOR] HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
            return null;
        }

        return await resp.json();
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error('[ORCHESTRATOR] Timeout (15s)');
        } else {
            console.error('[ORCHESTRATOR] Error:', err.message);
        }
        return null;
    }
}

export async function createApp() {
    await createServices({ sendToUI });
    const { memoryService, temporaryMemoryService, llmOrchestrator, recorridoService, ros2Control, visionManager, whisperASR, piperTTS, logger, personalidadRepo, hardwareControl, waiterAssistanceService, fase5SafetyService, tableService, ros2DeliverySimulator, orderHistoryService } = getServices();
    const analyticsService = new AnalyticsService({
        pool: getServices().pgPool,
        logger,
        getServiceHealth: async () => {
            const memory = await memoryService.healthCheck().catch(() => ({}));
            let orchestrator = { available: false };
            try {
                const response = await fetch(`${ORCHESTRATOR_URL}/health`, { signal: AbortSignal.timeout(1200) });
                if (response.ok) orchestrator = { ...(await response.json()), available: true };
            } catch {}
            let llm = { primary: false, fallback: false, active: 'unknown' };
            try {
                const primary = llmOrchestrator.primary?.getModelInfo?.();
                const fallback = llmOrchestrator.fallback?.getModelInfo?.();
                llm = {
                    primary: Boolean(primary),
                    fallback: Boolean(fallback),
                    active: llmOrchestrator.active === llmOrchestrator.primary ? (primary?.name || 'primary') : (fallback?.name || 'fallback'),
                };
            } catch {}
            return {
                checked_at: new Date().toISOString(),
                databases: memory,
                llm,
                orchestrator,
                asr: { whisper: Boolean(whisperASR?.disponible) },
                tts: { piper: Boolean(piperTTS?.disponible), python_ready: Boolean(ttsReady) },
                ros2: { mode: ros2Control?.mode || 'simulation', real_available: ros2Control?.real_available === true },
            };
        },
    });
    // Carga la personalidad desde BD y construye el system prompt.
    const personalidad = await personalidadRepo.get().catch(() => ({}));
    const menu = await memoryService.obtenerMenu().catch(() => []);
    const systemPrompt = buildSystemPrompt(personalidad, { menu });
    await llmOrchestrator.init(systemPrompt);
    // Expone reloadPersonalidad como un wrapper que regenera el prompt desde BD.
    llmOrchestrator.reloadPersonalidad = async () => {
        const nuevaPersonalidad = await personalidadRepo.get().catch(() => ({}));
        const nuevoMenu = await memoryService.obtenerMenu().catch(() => []);
        const nuevoPrompt = buildSystemPrompt(nuevaPersonalidad, { menu: nuevoMenu });
        return LlmOrchestrator.prototype.reloadPersonalidad.call(llmOrchestrator, nuevoPrompt);
    };

    // ── FASE 3/4: Orquestador LLM pagado + Gestión de Sesiones ──
    const fase3Orchestrator = new Fase3Orchestrator({ memoryService });
    const orderSessionManager = new OrderSessionManager({ memoryService });
    const WAITER_TIMEOUT_MS = Number(process.env.WAITER_TIMEOUT_MS) || 120_000;
    const waiterTimeouts = new Map();
    // La referencia queda disponible para cerrar la sesión si vence la
    // espera de un mesero, además de liberar el estado físico del robot.
    let sessionLifecycle = null;
    let speechPlayback = null;

    // ── HRI: Estado global del robot, gestión de turnos y mensajes proactivos ──
    const robotStateManager = new RobotStateManager({
        robotId: 'uchino-01',
        onStateChange: (prev, next, event) => {
            sendToUI({
                type: 'robot_state_changed',
                previous_state: event.previous_state,
                new_state: event.new_state,
                robot_id: event.robot_id,
                mesa: event.mesa,
                visit_id: event.visit_id || next.current_visit_id || null,
                session_id: event.session_id || next.current_session_id || null,
                order_id: event.order_id || next.current_order_id || null,
                label: ROBOT_STATE_LABELS[next.state] || next.state,
                color: ROBOT_STATE_COLORS[next.state] || '#64748B',
                timestamp: event.timestamp,
            });
            logger.log(`[RobotState] ${event.previous_state} → ${event.new_state} ${event.mesa ? `(mesa ${event.mesa})` : ''}`);

            // ── Proactive messages on state transitions ─────────────────
            const publishProactive = (msg, { speak = true, emotion = 'saludando' } = {}) => {
                const prepared = speechPlayback?.prepare(msg.rendered_text, {
                    source: 'proactive_message',
                    sessionId: event.session_id,
                    visitId: event.visit_id,
                    orderId: event.order_id,
                    mesa: event.mesa,
                });
                sendToUI({
                    type: 'proactive_message',
                    ...msg,
                    ...(prepared ? speechPayload(prepared) : {}),
                });
                if (speak && speechPlayback && prepared?.speechText) {
                    const playback = speechPlayback.speak(prepared, {
                        sanitized: true,
                        sessionId: event.session_id,
                        visitId: event.visit_id,
                        orderId: event.order_id,
                        mesa: event.mesa,
                        source: 'proactive_message',
                        emotion,
                    });
                    if (playback.ids.length > 0) proactiveMessages.markSpoken(msg.event_id);
                }
            };
            if (event.new_state === RobotState.ATTENDING
                && event.previous_state !== RobotState.ATTENDING) {
                const msg = proactiveMessages.createMessage(ProactiveEventType.ARRIVED_AT_TABLE, {
                    sessionId: event.session_id,
                    visitId: event.visit_id,
                    mesa: event.mesa,
                });
                if (msg) {
                    publishProactive(msg);
                }
            }
            // ── Waiter timeout ─────────────────────────────────────────
            if (event.new_state !== RobotState.WAITING_FOR_HUMAN_WAITER) {
                for (const [timeoutSessionId, timeoutHandle] of waiterTimeouts) {
                    clearTimeout(timeoutHandle);
                    waiterTimeouts.delete(timeoutSessionId);
                }
            }
            if (event.new_state === RobotState.WAITING_FOR_HUMAN_WAITER) {
                const timeoutSessionId = event.session_id;
                const timeoutMesa = event.mesa;
                const timeoutVisitId = event.visit_id || null;
                const previousTimeout = waiterTimeouts.get(timeoutSessionId);
                if (previousTimeout) clearTimeout(previousTimeout);
                const timeoutHandle = setTimeout(() => {
                    const current = robotStateManager.snapshot;
                    const ownsTimeout = waiterTimeouts.get(timeoutSessionId) === timeoutHandle;
                    waiterTimeouts.delete(timeoutSessionId);
                    if (ownsTimeout
                        && current.state === RobotState.WAITING_FOR_HUMAN_WAITER
                    && current.current_session_id === timeoutSessionId
                    && current.current_visit_id === timeoutVisitId) {
                        const closedSession = sessionLifecycle?.closeForHumanWaiter?.(timeoutSessionId);
                        if (!closedSession?.session) {
                            robotStateManager.release({ reason: 'waiter_timeout' });
                        }
                        sendToUI({
                            type: 'robot_released',
                            reason: 'waiter_timeout',
                            mesa: timeoutMesa,
                            session_id: timeoutSessionId,
                            timestamp: new Date().toISOString(),
                        });
                        logger.log(`[RobotState] Waiter timeout — robot released from mesa ${timeoutMesa}`);
                    }
                }, WAITER_TIMEOUT_MS);
                waiterTimeouts.set(timeoutSessionId, timeoutHandle);
            }
        },
        logger,
    });
    const turnManager = new TurnManager({ logger });
    const proactiveMessages = new ProactiveMessageService({ robotId: 'uchino-01', logger });

    // ── HRI: Staff mode toggle ─────────────────────────────────────────
    let isStaffMode = false;

    // La ruta binaria del robot comparte el mismo contrato determinístico de
    // /api/asr/process. Las frases sociales siguen usando el sidecar Python,
    // pero ninguna intención que pueda mutar un pedido se delega al LLM.
    async function processDeterministicVoiceTurn(state, text) {
        if (!state.sessionId) {
            return {
                response_text: 'No hay una sesión de atención activa. Espera la asignación de una mesa antes de hablar.',
                current_state: 'idle',
                actions: [],
                emotion: null,
                tts: null,
                deterministic: true,
                code: 'SESSION_REQUIRED',
            };
        }
        const session = orderSessionManager.getOrCreate(state.sessionId, {
            clientId: state.clientId || null,
            mesa: state.mesa || null,
        });
        const classification = classifyIntent({
            text,
            menu: orderSessionManager.getMenu(),
            draftItems: session.draft_items || [],
            state: session.state,
            interactionMode: session.interaction_mode,
            lastProduct: session.last_product_name,
        });

        if (classification.intent === Intent.SOCIAL_CONVERSATION) return null;

        // Classify routing family for downstream natural verbalization
        const routing = routeVoiceTurn({
            text,
            menu: orderSessionManager.getMenu(),
            draftItems: session.draft_items || [],
            state: session.state,
            interactionMode: session.interaction_mode,
            lastProduct: session.last_product_name,
            isStaffMode: isStaffMode,
            robotState: state.robotStateSnapshot || null,
        });

        // ── Routing decision: block if robot is in motion ────────────
        if (routing.decision === 'BLOCKED_ROBOT_IN_MOTION') {
            return {
                response_text: routing.reason || 'Estoy en movimiento y no puedo procesar tu pedido ahora. Por favor, espera un momento.',
                current_state: session.state,
                actions: [],
                emotion: null,
                tts: null,
                deterministic: true,
                code: 'ROBOT_IN_MOTION',
            };
        }

        // ── Routing decision: block if staff auth is required ────────
        if (routing.decision === 'BLOCKED_NO_STAFF_AUTH') {
            return {
                response_text: 'Este comando requiere autorización del personal. Solo un miembro del staff puede dar instrucciones operativas al robot.',
                current_state: session.state,
                actions: [],
                emotion: null,
                tts: null,
                deterministic: true,
                code: 'STAFF_AUTH_REQUIRED',
            };
        }

        if (!session.interaction_mode) {
            orderSessionManager.setInteractionMode(state.sessionId, 'voice');
        }

        const mesaMatch = String(text || '').match(/\bmesa\s*(?:n[uú]mero\s*)?(\d{1,2})\b/i);
        if (mesaMatch) {
            const mesaNumber = Number(mesaMatch[1]);
            if (mesaNumber >= 1 && mesaNumber <= 12) {
                state.mesa = normalizeMesa(mesaNumber);
            } else {
                return {
                    response_text: 'Solo puedo atender las mesas del M1 al M12.',
                    current_state: session.state,
                    actions: [],
                    emotion: null,
                    tts: null,
                    deterministic: true,
                    code: 'INVALID_TABLE',
                };
            }
        }
        const mesa = state.mesa || orderSessionManager.get(state.sessionId)?.mesa || null;
        if (!mesa) {
            return {
                response_text: 'Para continuar, indícame o selecciona primero el número de tu mesa.',
                current_state: orderSessionManager.get(state.sessionId)?.state || 'idle',
                actions: [],
                emotion: null,
                tts: null,
                deterministic: true,
                code: 'MISSING_TABLE',
            };
        }

        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3005}/api/asr/process`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(session.session_access_token ? { 'X-Session-Token': session.session_access_token } : {}),
                },
                body: JSON.stringify({
                    user_text: text,
                    session_id: state.sessionId,
                    source: 'robot_hardware_voice',
                    interaction_mode: 'voice',
                    mesa,
                    client_id: state.clientId || undefined,
                    suppress_tts: true,
                }),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                return {
                    response_text: data.error || 'No pude actualizar el pedido. Intenta nuevamente.',
                    current_state: data.state || orderSessionManager.get(state.sessionId)?.state || 'idle',
                    actions: [],
                    emotion: null,
                    tts: null,
                    deterministic: true,
                    code: data.code || `HTTP_${response.status}`,
                    ...data,
                };
            }
            state.mesa = data.mesa || mesa;
            if (data.confirmed || data.new_order || data.state === 'completed' || data.order_status === 'sent_to_kitchen') {
                state.voiceSessionClosed = true;
            }
            return {
                ...data,
                response_text: data.text || '',
                current_state: data.state || null,
                actions: [],
                emotion: null,
                tts: null,
                deterministic: true,
                ui_actions: routing.family === RouteFamily.STRUCTURED_QUERY ? (data.ui_actions || []) : [],
            };
        } catch (error) {
            return {
                response_text: 'No pude actualizar el pedido en este momento. No se realizó ningún cambio.',
                current_state: orderSessionManager.get(state.sessionId)?.state || 'idle',
                actions: [],
                emotion: null,
                tts: null,
                deterministic: true,
                code: error.name === 'AbortError' ? 'ASR_ROUTE_TIMEOUT' : 'ASR_ROUTE_UNAVAILABLE',
            };
        }
    }

    // Cargar menú desde DB al inicio + refrescar cada 30s
    await Promise.all([
        fase3Orchestrator.refreshMenu().catch(() => {}),
        orderSessionManager.refreshMenu().catch(() => {}),
    ]);
    console.log(`[FASE4] Fase3Orchestrator: modelo=${fase3Orchestrator.modelId} menú=${fase3Orchestrator.getMenuSource()} (${fase3Orchestrator.menu.length} items)`);
    console.log(`[FASE4] OrderSessionManager: ${orderSessionManager.getMenu().length} productos en menú (source=${orderSessionManager.getMenuSource()})`);
    setInterval(() => {
        fase3Orchestrator.refreshMenu().catch(() => {});
        orderSessionManager.refreshMenu().catch(() => {});
    }, 30 * 1000);
    setInterval(() => orderSessionManager.cleanup(), 10 * 60 * 1000); // cleanup cada 10 min

    // ── FASE 5: Local TTS Player (colocal, Kokoro, laptop) ──────
    const localTtsPlayer = new LocalTtsPlayer();
    localTtsPlayer.start().then(() => {
        console.log('[FASE5] LocalTTS player ready');
    }).catch(err => {
        console.warn('[FASE5] LocalTTS player no disponible:', err.message);
    });

    speechPlayback = new SpeechPlaybackService({
        player: localTtsPlayer,
        notify: sendToUI,
        logger,
        isSessionActive: (sessionId) => {
            if (!sessionId) return true;
            const session = orderSessionManager.get(sessionId);
            // La respuesta del turno de confirmación se reproduce mientras la
            // sesión está completando. Sólo una sesión cerrada/expirada es
            // obsoleta para voz.
            return Boolean(session && !['closed', 'expired'].includes(session.session_status));
        },
    });

    let micPaused = false;

    localTtsPlayer.on('playback_started', (event) => {
        micPaused = true;
        console.log(`[FASE5] mic_paused — reproduciendo: ${event.id?.slice(0, 8)}`);
    });

    localTtsPlayer.on('playback_completed', (event) => {
        micPaused = false;
        console.log(`[FASE5] mic_resumed — playback completado: ${event.id?.slice(0, 8)}`);
    });

    localTtsPlayer.on('playback_failed', (event) => {
        micPaused = false;
        console.warn(`[FASE5] mic_resumed — playback falló: ${event.id?.slice(0, 8)}`);
    });

    localTtsPlayer.on('cancelled', () => {
        micPaused = false;
        console.log('[FASE5] mic_resumed — playback cancelado');
    });

    // ── TTS Server (Python persistente) ──────────────────────────
    let ttsServerProc = null;
    const TTS_PORT = 3500;
    let ttsReady = false;

    function probeTtsServer() {
        return new Promise((resolve) => {
            const req = http.request(
                {
                    hostname: '127.0.0.1',
                    port: TTS_PORT,
                    path: '/health',
                    method: 'GET',
                    timeout: 2000,
                },
                (res) => {
                    let body = '';
                    res.on('data', (chunk) => { body += chunk; });
                    res.on('end', () => resolve(res.statusCode === 200 && body.length > 0));
                }
            );
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.end();
        });
    }

    async function startTtsServer() {
        if (await probeTtsServer()) {
            ttsReady = true;
            logger.log(`[TTS] reutilizando servidor existente en puerto ${TTS_PORT}`);
            return;
        }
        const scriptPath = join(__dirname, '../../tts/tts_server.py');
        const env = { ...process.env, TTS_PORT: String(TTS_PORT) };
        const proc = spawn('python3', [scriptPath], {
            cwd: join(__dirname, '../..'),
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
        });
        proc.stdout.on('data', d => logger.log(`[TTS] ${d.toString().trim()}`));
        proc.stderr.on('data', d => {
            const msg = d.toString().trim();
            if (msg) logger.log(`[TTS] ${msg}`);
        });
        proc.on('exit', async (code) => {
            const reused = await probeTtsServer();
            if (reused) {
                ttsReady = true;
                ttsServerProc = null;
                logger.log(`[TTS] proceso terminó (código ${code}); servidor externo sigue disponible en ${TTS_PORT}`);
                return;
            }
            logger.log(`[TTS] proceso terminado (código ${code}), reiniciando en 2s...`);
            ttsReady = false;
            ttsServerProc = null;
            setTimeout(() => {
                startTtsServer().catch((err) => logger.error(`[TTS] reinicio falló: ${err.message}`));
            }, 2000);
        });
        proc.on('error', (e) => logger.error(`[TTS] error al iniciar: ${e.message}`));
        ttsServerProc = proc;
        // Esperar a que el servidor Python responda health check
        (async function waitForTts() {
            for (let i = 0; i < 60; i++) {
                await new Promise(r => setTimeout(r, 1000));
                try {
                    const h = await new Promise((resolve, reject) => {
                        const req = http.request({ hostname: '127.0.0.1', port: TTS_PORT, path: '/health', method: 'GET', timeout: 2000 }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>resolve(d)); });
                        req.on('error', reject); req.end();
                    });
                    if (h) { ttsReady = true; logger.log(`[TTS] servidor listo (puerto ${TTS_PORT})`); return; }
                } catch {}
            }
            logger.error(`[TTS] no respondió tras 60s`);
        })();
    }

    function ttsRequest(text, emotion, useRvc) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({ text, emotion: emotion || null, use_rvc: !!useRvc });
            const opts = {
                hostname: '127.0.0.1', port: TTS_PORT, path: '/speak',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            };
            const req = http.request(opts, (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); }
                    catch { reject(new Error('invalid JSON from TTS server')); }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    startTtsServer().catch((err) => logger.error(`[TTS] init falló: ${err.message}`));

    const app = express();
    const server = createServer(app);
    const wss = new WebSocketServer({ noServer: true });
    const esp32LabWss = new WebSocketServer({ noServer: true });
    const visionWss = new WebSocketServer({ noServer: true });
    const uiWss = new WebSocketServer({ noServer: true });
    const uiClients = new Map();
    const robotUiClients = new Map();
    let uiEventSequence = 0;
    const audioLabState = {
        esp32: {
            connected: false,
            remoteAddress: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            transportPath: null,
        },
        telemetry: null,
        lastAsrPartial: '',
        lastAsrFinal: '',
        lastResponseText: '',
        conversationState: 'IDLE',
        tts: {
            chunks: 0,
            bytes: 0,
            durationMs: 0,
            lastSentAt: null,
        },
        uplink: {
            pcmFrames: 0,
            pcmBytes: 0,
            lastFrameAt: null,
            lastFrameType: null,
            backendPcmBypassed: AUDIO_LAB_ISOLATE_ESP32_PCM,
        },
        events: [],
    };

    function clampAudioLabEvents() {
        if (audioLabState.events.length > 40) {
            audioLabState.events.splice(0, audioLabState.events.length - 40);
        }
    }

    function pushAudioLabEvent(name, detail = {}) {
        const event = {
            id: randomUUID(),
            name,
            at: new Date().toISOString(),
            detail,
        };
        audioLabState.events.push(event);
        clampAudioLabEvents();
        sendToUI({ type: 'audio_lab_event', event });
        return event;
    }

    function getAudioLabSnapshot() {
        return {
            esp32: audioLabState.esp32,
            telemetry: audioLabState.telemetry,
            last_asr_partial: audioLabState.lastAsrPartial,
            last_asr_final: audioLabState.lastAsrFinal,
            last_response_text: audioLabState.lastResponseText,
            conversation_state: audioLabState.conversationState,
            tts: audioLabState.tts,
            uplink: audioLabState.uplink,
            hardware: hardwareControl.getState(),
            events: audioLabState.events,
        };
    }

    function markEsp32Connected({ remoteAddress, transportPath }) {
        audioLabState.esp32 = {
            connected: true,
            remoteAddress: remoteAddress || null,
            lastConnectedAt: new Date().toISOString(),
            lastDisconnectedAt: audioLabState.esp32.lastDisconnectedAt,
            transportPath: transportPath || null,
        };
        pushAudioLabEvent('esp32_connected', {
            remoteAddress: remoteAddress || null,
            transportPath: transportPath || null,
        });
        emitAudioLabMetrics();
    }

    function markEsp32Disconnected({ code, reason, transportPath }) {
        audioLabState.esp32 = {
            ...audioLabState.esp32,
            connected: false,
            lastDisconnectedAt: new Date().toISOString(),
        };
        pushAudioLabEvent('esp32_disconnected', {
            code,
            reason: reason?.toString() || 'n/a',
            transportPath: transportPath || audioLabState.esp32.transportPath || null,
        });
        emitAudioLabMetrics();
    }

    const SNIFF_ESP32_PCM = process.env.SNIFF_ESP32_PCM === '1';
    const SNIFF_OUT_DIR = process.env.SNIFF_OUT_DIR || '/tmp';
    const sniffState = { mono: null, stereo: null, count: 0, file: null };

    function recordEsp32Frame({ frame, logPrefix = '[WS Robot]', seqForState = null }) {
        if (!frame || frame.length < 6) {
            return false;
        }
        const magic = frame[0];
        if (magic !== 0xA5) {
            return false;
        }
        const type = frame[1];
        const seq = frame.readUInt16BE(2);
        const len = frame.readUInt16BE(4);
        const payload = frame.slice(6, 6 + len);

        if (seqForState) {
            seqForState.lastSeq = seq;
        }

        if (type === 0x01 || type === 0x02) {
            audioLabState.uplink.pcmFrames += 1;
            audioLabState.uplink.pcmBytes += payload.length;
            audioLabState.uplink.lastFrameAt = new Date().toISOString();
            audioLabState.uplink.lastFrameType = type;
            if (audioLabState.uplink.pcmFrames <= 5) {
                logger.log(`${logPrefix} PCM frame rx`, { seq, type, bytes: payload.length });
            }
            if (SNIFF_ESP32_PCM) {
                if (type === 0x01) {
                    if (!sniffState.mono) sniffState.mono = [];
                    sniffState.mono.push(payload);
                } else {
                    if (!sniffState.stereo) sniffState.stereo = [];
                    sniffState.stereo.push(payload);
                }
                sniffState.count += 1;
                if (sniffState.count === 1) {
                    sniffState.file = `${SNIFF_OUT_DIR}/esp32_sniff_${Date.now()}_${type === 0x01 ? 'mono' : 'stereo'}.raw`;
                    logger.log(`[SNIFF] starting capture to ${sniffState.file}`);
                }
                if (sniffState.count % 100 === 0) {
                    const buf = Buffer.concat(type === 0x01 ? sniffState.mono : sniffState.stereo);
                    sniffWriteFileSync(sniffState.file, buf);
                    logger.log(`[SNIFF] partial write: ${sniffState.count} frames, ${buf.length} bytes`);
                }
            }
            emitAudioLabMetrics();
            return { type, seq, payload };
        }

        if (type === 0x03) {
            try {
                const metadata = JSON.parse(payload.toString());
                logger.log(`${logPrefix} AudioCompass`, metadata);
                audioLabState.telemetry = {
                    ...metadata,
                    receivedAt: new Date().toISOString(),
                };
                emitAudioLabMetrics();
                return { type, seq, payload };
            } catch (e) {
                logger.warn(`${logPrefix} AudioCompass JSON parse error:`, e.message);
                return { type, seq, payload };
            }
        }

        return { type, seq, payload };
    }

    function emitAudioLabMetrics() {
        sendToUI({ type: 'audio_lab_metrics', snapshot: getAudioLabSnapshot() });
    }

    function sendToUI(data) {
        const safeData = data;
        const timestamp = safeData?.timestamp || new Date().toISOString();
        const payload = {
            ...safeData,
            event_id: safeData?.event_id || randomUUID(),
            timestamp,
            created_at: safeData?.created_at || timestamp,
            expires_at: safeData?.expires_at || null,
            table_id: safeData?.table_id || safeData?.mesa || null,
            status: safeData?.status || safeData?.new_state || safeData?.current_status || null,
            sequence: ++uiEventSequence,
        };
        for (const client of uiClients.values()) {
            if (client.ws.readyState === 1) {
                const projected = projectUiEvent(payload, client);
                if (projected) client.ws.send(JSON.stringify(projected));
            }
        }
        if (['nuevo_pedido', 'pedido_actualizado'].includes(payload?.type)) {
            try {
                getServices().ros2DeliverySimulator?.observeOrderEvent(payload);
            } catch {
                // The service registry is not available during early startup.
            }
        }
    }

    function createSocketAudioWriter(socket) {
        return {
            isOpen: () => !socket.destroyed,
            send: (frame) => {
                if (socket.destroyed) return false;
                return socket.write(frame);
            },
            write: (frame) => {
                if (socket.destroyed) return false;
                return socket.write(frame);
            },
        };
    }

    function createWebSocketAudioWriter(ws) {
        return {
            isOpen: () => ws.readyState === 1,
            send: (frame) => {
                if (ws.readyState !== 1) return false;
                ws.send(frame);
                return true;
            },
        };
    }

    function createVoiceState(clientId = null) {
        return {
            audioBuffer: Buffer.alloc(0),
            conversationState: 'IDLE',
            silenceCounter: 0,
            lastAudioTime: Date.now(),
            lastSeq: 0,
            ultimoTextoConfirmado: null,
            bufferTemporalTranscribiendo: '',
            // La sesión conversacional siempre la entrega el backend de
            // lifecycle. Los transportes físicos no pueden inventar una.
            sessionId: null,
            mesa: null,
            wakeWordDetected: false,
            sessionStartedAt: Date.now(),
            clientId,
            dedicatedWhisper: null,
            sttReady: false,
            mutedUntil: 0,
            ttsFinishTimer: null,
            ttsPendingUntil: 0,
            voiceSessionClosed: false,
            audioRejectionEmitted: false,
        };
    }

    function attachTranscriptionListener(state) {
        return (msg) => {
            if (msg.timestamp && msg.timestamp < state.sessionStartedAt) {
                return;
            }
            // Solo sobreescribir con texto confirmado — el buffer parcial NO debe
            // reemplazar un confirmed ya guardado, solo se usa para la UI parcial.
            if (msg.confirmed && msg.confirmed.trim()) {
                logger.log('[ASR] Texto confirmado recibido:', msg.confirmed.slice(0, 80));
                state.ultimoTextoConfirmado = msg.confirmed;
            } else if (msg.buffer && msg.buffer.trim() && !state.ultimoTextoConfirmado) {
                // Guardamos el parcial solo si no hay un confirmed todavía
                state.ultimoTextoConfirmado = msg.buffer;
            }
            state.bufferTemporalTranscribiendo = msg.buffer || '';
            audioLabState.lastAsrPartial = msg.buffer || '';
            emitAudioLabMetrics();
        };
    }

    async function startDedicatedWhisper(state, onTranscription, logPrefix) {
        try {
            const { WhisperASRService } = await import('./application/WhisperASR.mjs');
            // Puerto 8002 = WhisperLiveKit directo (sin proxy audio_pipeline)
            // Puerto 8001 = audio_pipeline proxy que rechaza conexiones externas de Node.js
            const dedicatedWhisper = new WhisperASRService({ noWakeWord: true, port: 8002 });
            await new Promise(resolve => {
                if (dedicatedWhisper.disponible) return resolve();
                dedicatedWhisper.once('ready', resolve);
                setTimeout(resolve, 2000);
            });
            state.dedicatedWhisper = dedicatedWhisper;
            state.sttReady = true;
            dedicatedWhisper.on('transcription', onTranscription);
            logger.log(`${logPrefix} Dedicated WhisperASR ready`);
        } catch (error) {
            logger.error(`${logPrefix} Dedicated WhisperASR init failed:`, error.message);
        }
    }

    const audioCleaner = createAudioCleaner({
        dcBlockR: 0.984,        // ~50Hz high-pass
        gateThreshold: 120,     // RMS threshold to open gate
        gateHoldFrames: 10,     // hold open 10 frames after signal
        highpass: process.env.UCHINO_DCBLOCK !== '0',
    });

    function framePayloadForAsr(type, payload) {
        if (type === TYPE_PCM_STEREO) {
            // Apply DC blocker + noise gate on stereo first, then downmix
            const cleaned = audioCleaner.processStereoPcm(payload);
            const mono = downmixStereoPcm16ToMono(cleaned, { mode: 'average' });
            return applyGainLimit(mono);
        }
        const cleaned = audioCleaner.processMonoPcm(payload);
        return applyGainLimit(cleaned);
    }

    function applyGainLimit(pcm) {
        if (!Buffer.isBuffer(pcm) || pcm.length < 2) return pcm;
        const samples = Math.floor(pcm.length / 2);
        let maxAbs = 0;
        for (let i = 0; i < samples; i++) {
            const v = pcm.readInt16LE(i * 2);
            const a = v < 0 ? -v : v;
            if (a > maxAbs) maxAbs = a;
        }
        if (maxAbs <= 28000) return pcm;
        const scale = 28000 / maxAbs;
        for (let i = 0; i < samples; i++) {
            const v = pcm.readInt16LE(i * 2);
            const scaled = Math.max(-32768, Math.min(32767, Math.round(v * scale)));
            pcm.writeInt16LE(scaled, i * 2);
        }
        return pcm;
    }

    function cancelServerTts(state, reason = 'barge_in') {
        if (state?.ttsFinishTimer) {
            clearTimeout(state.ttsFinishTimer);
            state.ttsFinishTimer = null;
        }
        if (state) {
            state.ttsPendingUntil = 0;
            state.mutedUntil = 0;
        }
        if (turnManager.snapshot.tts_session_id === state?.sessionId) turnManager.cancelTts({ reason });
        speechPlayback?.cancel({ reason, sessionId: state?.sessionId });
    }

    function handleVoicePcmFrame({ state, type, payload, role, audioWriter, logPrefix }) {
        const session = state.sessionId ? orderSessionManager.get(state.sessionId) : null;
        if (!state.sessionId || !session || isStaleSession(session) || state.voiceSessionClosed) {
            if (!state.audioRejectionEmitted) {
                state.audioRejectionEmitted = true;
                sendToUI({
                    type: state.sessionId ? 'late_audio_rejected' : 'audio_session_required',
                    session_id: state.sessionId,
                    session_status: session?.session_status || null,
                    timestamp: new Date().toISOString(),
                });
            }
            state.voiceSessionClosed = Boolean(state.sessionId && (isStaleSession(session) || state.voiceSessionClosed));
            return;
        }
        if (role === 'esp32' && AUDIO_LAB_ISOLATE_ESP32_PCM) {
            return;
        }
        if (Date.now() < state.mutedUntil) {
            // During TTS playback, check for barge-in (user speaking over robot)
            if (turnManager.isTtsActive) {
                const bargeResult = turnManager.userStartedSpeaking({
                    sessionId: state.sessionId,
                });
                if (bargeResult.bargeIn) {
                    logger.log(`${logPrefix} Barge-in detected during TTS playback, cancelling`);
                    cancelServerTts(state, 'barge_in');
                    state.conversationState = 'LISTENING';
                    state.audioBuffer = Buffer.alloc(0);
                    audioLabState.conversationState = 'LISTENING';
                    emitAudioLabMetrics();
                    // Don't return — let the new utterance through
                } else {
                    return;
                }
            } else {
                return;
            }
        }
        if (state.conversationState === 'PROCESSING') {
            // Check barge-in during processing
            if (turnManager.isTtsActive) {
                const bargeResult = turnManager.userStartedSpeaking({
                    sessionId: state.sessionId,
                });
                if (bargeResult.bargeIn) {
                    logger.log(`${logPrefix} Barge-in detected during processing, cancelling TTS`);
                    cancelServerTts(state, 'barge_in');
                    state.conversationState = 'LISTENING';
                    state.audioBuffer = Buffer.alloc(0);
                    audioLabState.conversationState = 'LISTENING';
                    emitAudioLabMetrics();
                    // Don't return — process the new utterance
                } else {
                    return;
                }
            } else {
                return;
            }
        }

        const asrPayload = framePayloadForAsr(type, payload);

        if (state.conversationState === 'IDLE') {
            state.conversationState = 'LISTENING';
            audioLabState.conversationState = 'LISTENING';
            pushAudioLabEvent('vad_listening', { role, clientId: state.clientId || null });
            emitAudioLabMetrics();
            logger.log(`${logPrefix} VAD IDLE -> LISTENING`);
        }

        state.audioBuffer = Buffer.concat([state.audioBuffer, asrPayload]);
        state.lastAudioTime = Date.now();

        if (state.sttReady && state.dedicatedWhisper) {
            state.dedicatedWhisper.enviarAudio(asrPayload);
        }

        const isSilent = detectSilence(asrPayload, 200);
        if (isSilent) {
            state.silenceCounter++;
        } else {
            state.silenceCounter = 0;
        }

        if (state.conversationState === 'LISTENING' && state.silenceCounter >= 15) {
            state.conversationState = 'PROCESSING';
            audioLabState.conversationState = 'PROCESSING';
            pushAudioLabEvent('vad_processing', { reason: 'silence', clientId: state.clientId || null });
            emitAudioLabMetrics();
            logger.log(`${logPrefix} VAD LISTENING -> PROCESSING (silence)`);
            if (state.sttReady && state.dedicatedWhisper) {
                processVoiceTurn(state, audioWriter, state.dedicatedWhisper, llmOrchestrator, piperTTS, logger, processDeterministicVoiceTurn);
            }
        }

        if (state.audioBuffer.length >= 256000 && state.conversationState === 'LISTENING') {
            state.conversationState = 'PROCESSING';
            audioLabState.conversationState = 'PROCESSING';
            pushAudioLabEvent('vad_processing', { reason: 'max_buffer', clientId: state.clientId || null });
            emitAudioLabMetrics();
            logger.log(`${logPrefix} VAD LISTENING -> PROCESSING (max buffer)`);
            if (state.sttReady && state.dedicatedWhisper) {
                processVoiceTurn(state, audioWriter, state.dedicatedWhisper, llmOrchestrator, piperTTS, logger, processDeterministicVoiceTurn);
            }
        }
    }

    let esp32LabTcpSocket = null;

    function clearTcpLabSocket(socket) {
        if (esp32LabTcpSocket === socket) {
            esp32LabTcpSocket = null;
        }
    }

    const esp32LabTcpServer = net.createServer((socket) => {
        const remoteAddress = socket.remoteAddress || null;
        logger.log('TCP ESP32 Lab conectado:', remoteAddress);

        if (esp32LabTcpSocket && esp32LabTcpSocket !== socket) {
            esp32LabTcpSocket.destroy();
        }
        esp32LabTcpSocket = socket;
        const tcpAudioWriter = createSocketAudioWriter(socket);
        const state = createVoiceState(null);
        hardwareControl.registerAudioSink(tcpAudioWriter, { transport: 'tcp' });
        markEsp32Connected({
            remoteAddress,
            transportPath: `tcp://0.0.0.0:${AUDIO_LAB_TCP_PORT}`,
        });

        let pending = Buffer.alloc(0);

        socket.on('data', (chunk) => {
            logger.log(`[TCP ESP32 Lab] rx chunk len=${chunk.length}`);
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 6) {
                if (pending[0] !== 0xA5) {
                    logger.warn('TCP ESP32 Lab frame con magic invalido, descartando 1 byte');
                    pending = pending.slice(1);
                    continue;
                }
                const payloadLen = pending.readUInt16BE(4);
                const frameLen = 6 + payloadLen;
                logger.log(`[TCP ESP32 Lab] Need frameLen=${frameLen}, have=${pending.length}`);
                if (pending.length < frameLen) {
                    break;
                }
                logger.log(`[TCP ESP32 Lab] Processing frame of len=${frameLen}`);
                const frame = pending.subarray(0, frameLen);
                pending = pending.slice(frameLen);
                const parsed = recordEsp32Frame({
                    frame,
                    logPrefix: '[TCP ESP32 Lab]',
                });
                logger.log(`[TCP ESP32 Lab] parsed type=0x${(parsed?.type ?? 0).toString(16)} seq=${parsed?.seq} payloadLen=${parsed?.payload?.length ?? 0}`);
                if (parsed && parsed.type === 0x10) {
                    const fillPct = parsed.payload.length >= 1 ? parsed.payload[0] : 0;
                    const freeBytes = parsed.payload.length >= 3 ? parsed.payload.readUInt16BE(1) : 0;
                    hardwareControl._esp32BufferFillPct = fillPct;
                    hardwareControl._esp32BufferFreeBytes = freeBytes;
                    logger.log(`[TCP ESP32 Lab] TTS ACK: fill=${fillPct}% free=${freeBytes}`);
                } else if (parsed && (parsed.type === TYPE_PCM_MONO || parsed.type === TYPE_PCM_STEREO)) {
                    handleVoicePcmFrame({
                        state,
                        type: parsed.type,
                        payload: parsed.payload,
                        role: 'esp32',
                        audioWriter: tcpAudioWriter,
                        logPrefix: '[TCP ESP32 Lab]',
                    });
                }
            }
        });

        socket.on('close', (hadError) => {
            logger.log(`TCP ESP32 Lab desconectado (hadError=${hadError ? 1 : 0})`);
            const wasActive = esp32LabTcpSocket === socket;
            clearTcpLabSocket(socket);
            hardwareControl.unregisterAudioSink(tcpAudioWriter);
            if (SNIFF_ESP32_PCM && sniffState.file) {
                try {
                    const buf = sniffState.stereo && sniffState.stereo.length
                        ? Buffer.concat(sniffState.stereo)
                        : Buffer.concat(sniffState.mono || []);
                    const finalFile = sniffState.file.replace('.raw', `_final_${buf.length}bytes.raw`);
                    sniffWriteFileSync(finalFile, buf);
                    logger.log(`[SNIFF] final write: ${sniffState.count} frames, ${buf.length} bytes -> ${finalFile}`);
                } catch (e) {
                    logger.error(`[SNIFF] final write error: ${e.message}`);
                }
            }
            if (!wasActive) {
                return;
            }
            markEsp32Disconnected({
                code: hadError ? 1006 : 1000,
                reason: hadError ? 'tcp_error' : 'tcp_closed',
                transportPath: `tcp://0.0.0.0:${AUDIO_LAB_TCP_PORT}`,
            });
        });

        socket.on('error', (err) => {
            logger.log(`TCP ESP32 Lab error: ${err.message}`);
        });
    });

    esp32LabTcpServer.on('error', (err) => {
        logger.error(`[TCP ESP32 Lab] error del servidor: ${err.message}`);
    });

    esp32LabTcpServer.listen(AUDIO_LAB_TCP_PORT, '0.0.0.0', () => {
        logger.log(`[TCP ESP32 Lab] escuchando en 0.0.0.0:${AUDIO_LAB_TCP_PORT}`);
    });

    /* ── USB Serial Relay (desde /dev/ttyACM0 vía Python relay) ── */
    const USB_RELAY_TCP_PORT = Number(process.env.USB_RELAY_TCP_PORT || 3012);
    const usbRelayServer = net.createServer((socket) => {
        const remoteAddress = socket.remoteAddress || null;
        logger.log(`[USB Relay] conectado desde ${remoteAddress}`);
        const state = createVoiceState(null);

        let pending = Buffer.alloc(0);

        socket.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 6) {
                if (pending[0] !== 0xA5) {
                    pending = pending.slice(1);
                    continue;
                }
                const payloadLen = pending.readUInt16BE(4);
                const frameLen = 6 + payloadLen;
                if (pending.length < frameLen) break;

                const frame = pending.subarray(0, frameLen);
                pending = pending.slice(frameLen);
                const parsed = recordEsp32Frame({
                    frame,
                    logPrefix: '[USB Relay]',
                });
                if (parsed && (parsed.type === TYPE_PCM_MONO || parsed.type === TYPE_PCM_STEREO)) {
                    handleVoicePcmFrame({
                        state,
                        type: parsed.type,
                        payload: parsed.payload,
                        role: 'esp32',
                        audioWriter: null,
                        logPrefix: '[USB Relay]',
                    });
                }
            }
        });

        socket.on('close', () => {
            logger.log('[USB Relay] desconectado');
        });

        socket.on('error', (err) => {
            logger.log(`[USB Relay] error: ${err.message}`);
        });
    });

    usbRelayServer.listen(USB_RELAY_TCP_PORT, '127.0.0.1', () => {
        logger.log(`[USB Relay] escuchando en 127.0.0.1:${USB_RELAY_TCP_PORT}`);
    });

    server.on('upgrade', (request, socket, head) => {
        const origin = String(request.headers.origin || '');
        const urlPath = (request.url || '').split('?')[0];
        const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3005,http://127.0.0.1:3005,http://localhost:5173,http://127.0.0.1:5173')
            .split(',')
            .map(value => value.trim())
            .filter(Boolean);
        const originRequired = urlPath === '/ws/ui';
        if ((originRequired && !origin) || (origin && !allowedOrigins.includes(origin))) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        if (urlPath === '/ws/robot') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else if (urlPath === '/ws/esp32-lab') {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } else if (urlPath === '/ws/vision') {
            visionWss.handleUpgrade(request, socket, head, (ws) => {
                visionWss.emit('connection', ws, request);
            });
        } else if (urlPath === '/ws/ui') {
            uiWss.handleUpgrade(request, socket, head, (ws) => {
                uiWss.emit('connection', ws, request);
            });
        } else {
            socket.destroy();
        }
    });

    uiWss.on('connection', (ws) => {
        logger.log('WS UI conectado');
        const client = {
            ws,
            role: 'public',
            sessionId: null,
            connectionId: randomUUID(),
            robotId: null,
            robotConnectionToken: null,
        };
        uiClients.set(ws, client);
        ws.send(JSON.stringify(projectUiEvent({ type: 'audio_lab_metrics', snapshot: getAudioLabSnapshot() }, client)));
        ws.on('close', () => {
            uiClients.delete(ws);
            if (client.robotId && robotUiClients.get(client.robotId) === client) {
                robotUiClients.delete(client.robotId);
            }
            sessionLifecycle?.revokeRobotConnection({ connectionToken: client.robotConnectionToken });
            logger.log('WS UI desconectado');
        });
        ws.on('error', (err) => {
            logger.log(`WS UI error: ${err.message}`);
        });
        ws.on('message', (data) => {
            // Los mensajes del frontend UI son solo keepalive/registro
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong' }));
                    return;
                }
                if (msg.type === 'robot_register') {
                    const robotId = String(msg.robot_id || '').trim();
                    const existing = robotUiClients.get(robotId);
                    if (!robotId || !sessionLifecycle) {
                        ws.send(JSON.stringify({ type: 'robot_registration_rejected', code: 'ROBOT_REGISTRATION_REQUIRED' }));
                        return;
                    }
                    if (existing && existing !== client && existing.ws.readyState === 1) {
                        ws.send(JSON.stringify({ type: 'robot_registration_rejected', robot_id: robotId, code: 'ROBOT_SURFACE_BUSY' }));
                        return;
                    }
                    if (client.robotId && robotUiClients.get(client.robotId) === client) {
                        robotUiClients.delete(client.robotId);
                    }
                    sessionLifecycle.revokeRobotConnection({ connectionToken: client.robotConnectionToken });
                    const binding = sessionLifecycle.registerRobotConnection({
                        robotId,
                        connectionId: client.connectionId,
                    });
                    client.robotId = robotId;
                    client.robotConnectionToken = binding.robot_connection_token;
                    robotUiClients.set(robotId, client);
                    ws.send(JSON.stringify(projectUiEvent({ type: 'robot_registered', ...binding }, client)));
                    return;
                }
                if (msg.type === 'robot_bootstrap_request') {
                    const robotId = String(msg.robot_id || '');
                    const connectionValid = client.role === 'public'
                        && client.robotId === robotId
                        && sessionLifecycle?.validateRobotConnection({
                            robotId,
                            connectionId: client.connectionId,
                            connectionToken: client.robotConnectionToken,
                        });
                    if (!connectionValid) {
                        ws.send(JSON.stringify({ type: 'robot_bootstrap_rejected', robot_id: robotId, code: 'ROBOT_CONNECTION_REQUIRED' }));
                        return;
                    }
                    const grant = sessionLifecycle.getRobotBootstrapGrant({
                        robotId,
                        sessionId: msg.session_id ? String(msg.session_id) : null,
                    });
                    if (grant) {
                        ws.send(JSON.stringify(projectUiEvent({
                            type: 'robot_session_bootstrap',
                            ...grant,
                            robot_connection_token: client.robotConnectionToken,
                            timestamp: new Date().toISOString(),
                        }, client)));
                    }
                    return;
                }
                if (msg.type === 'auth') {
                    const token = String(msg.token || '').trim();
                    let role = 'public';
                    let sessionId = null;
                    try {
                        const claims = jwt.verify(token, JWT_SECRET);
                        if (claims?.role === 'admin' || claims?.is_admin === true) role = 'admin';
                    } catch {
                        const candidateSessionId = String(msg.session_id || '').trim();
                        const session = candidateSessionId ? orderSessionManager.get(candidateSessionId) : null;
                        if (session && session.session_access_token && token === session.session_access_token && !isStaleSession(session)) {
                            role = 'session';
                            sessionId = candidateSessionId;
                        }
                    }
                    client.role = role;
                    client.sessionId = sessionId;
                    ws.send(JSON.stringify({ type: 'ui_authenticated', authenticated: role !== 'public', role }));
                    if (role === 'admin') {
                        ws.send(JSON.stringify(projectUiEvent({ type: 'audio_lab_metrics', snapshot: getAudioLabSnapshot() }, client)));
                    }
                }
            } catch {}
        });
    });

    esp32LabWss.on('connection', (ws, req) => {
        logger.log('WS ESP32 Lab conectado:', req.socket.remoteAddress);
        hardwareControl.registerRobotClient(ws, {
            role: 'esp32',
            clientId: null,
            skipInitialVolume: true,
        });
        markEsp32Connected({
            remoteAddress: req.socket.remoteAddress || null,
            transportPath: '/ws/esp32-lab',
        });

        ws.on('message', (data, isBinary) => {
            const frame = Buffer.isBuffer(data)
                ? data
                : isBinary || data instanceof ArrayBuffer || ArrayBuffer.isView(data)
                    ? Buffer.from(data)
                    : null;

            if (!frame) {
                return;
            }

            recordEsp32Frame({
                frame,
                logPrefix: '[WS ESP32 Lab]',
            });
        });

        ws.on('close', (code, reason) => {
            logger.log(`WS ESP32 Lab desconectado (code=${code}, reason=${reason?.toString() || 'n/a'})`);
            hardwareControl.unregisterRobotClient(ws);
            markEsp32Disconnected({
                code,
                reason,
                transportPath: '/ws/esp32-lab',
            });
        });

        ws.on('error', (err) => {
            logger.log(`WS ESP32 Lab error: ${err.message}`);
        });
    });

    // CORS + JSON body parser + static frontend (multi-page build)
    const corsOrigins = new Set(
        String(process.env.CORS_ALLOWED_ORIGINS || 'http://localhost:3005,http://127.0.0.1:3005,http://localhost:5173,http://127.0.0.1:5173')
            .split(',')
            .map(origin => origin.trim())
            .filter(Boolean),
    );
    app.use(cors({
        origin: (origin, callback) => callback(null, !origin || corsOrigins.has(origin)),
        credentials: true,
    }));
    app.use(express.json());
    app.use('/assets', express.static(join(__dirname, '../../frontend_ui/dist/assets')));
    const sendHtmlNoCache = (res, filePath) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.sendFile(filePath);
    };
    app.get('/robot', (_, res) => sendHtmlNoCache(res, join(__dirname, '../../frontend_ui/dist/robot.html')));
    app.get('/cocina', (_, res) => sendHtmlNoCache(res, join(__dirname, '../../frontend_ui/dist/cocina.html')));
    app.get('/admin', (_, res) => sendHtmlNoCache(res, join(__dirname, '../../frontend_ui/dist/admin.html')));
    app.get('/audio-lab', (_, res) => sendHtmlNoCache(res, join(__dirname, '../../frontend_ui/dist/audio-lab.html')));
    app.get('/voz', (_, res) => sendHtmlNoCache(res, join(__dirname, '../../chipi_voz.html')));
    app.get('/voz-rvc', (_, res) => sendHtmlNoCache(res, join(__dirname, '../../chipi_voz_rvc.html')));
    // ── Health Check ──────────────────────────────────────────
    app.get('/api/status', async (req, res) => {
        const t0 = Date.now();
        const memHealth = await memoryService.healthCheck().catch(() => ({}));

        // Check LLM providers
        let llmHealth = { primary: false, fallback: false, active: 'unknown' };
        try {
            const primaryInfo = llmOrchestrator.primary?.getModelInfo?.();
            const fallbackInfo = llmOrchestrator.fallback?.getModelInfo?.();
            llmHealth = {
                primary: !!primaryInfo,
                fallback: !!fallbackInfo,
                active: llmOrchestrator.active === llmOrchestrator.primary
                    ? (primaryInfo?.name || 'primary')
                    : (fallbackInfo?.name || 'fallback'),
                onFallback: llmOrchestrator.onFallback,
            };
        } catch (e) {
            llmHealth.error = e.message;
        }

        // Check TTS
        let ttsHealth = { piper: false, kokoro: false, python_ready: false, local_player: false };
        try {
            ttsHealth = {
                piper: !!piperTTS?.disponible,
                kokoro: false, // Se mantiene por compatibilidad: el servidor Python expone python_ready.
                python_ready: ttsReady,
                local_player: !!localTtsPlayer?.isReady,
            };
        } catch (e) {
            ttsHealth.error = e.message;
        }

        // Check ASR
        let asrHealth = { whisper: false };
        try {
            asrHealth = {
                whisper: !!whisperASR?.disponible,
            };
        } catch (e) {
            asrHealth.error = e.message;
        }

        // Check Python Orchestrator sidecar
        let orchestratorHealth = { available: false };
        try {
            const orchResp = await fetch(`${ORCHESTRATOR_URL}/health`, { signal: AbortSignal.timeout(3000) });
            if (orchResp.ok) {
                orchestratorHealth = await orchResp.json();
                orchestratorHealth.available = true;
            }
        } catch (e) {
            orchestratorHealth = { available: false, error: e.message };
        }

        // Check Vision
        let visionHealth = { available: false, mockMode: false };
        try {
            visionHealth = {
                available: !!visionManager,
                mockMode: visionManager?.mockMode || false,
                stats: visionManager?.getStats?.() || {},
            };
        } catch (e) {
            visionHealth.error = e.message;
        }

        // Check ROS2
        let ros2Health = { available: false };
        try {
            const rosState = await ros2Control?.getState?.();
            ros2Health = {
                // Un estado placeholder no demuestra que ROS2 físico esté
                // conectado. La disponibilidad real requiere un adaptador
                // explícito que marque real_available=true.
                available: ros2Control?.real_available === true,
                mode: ros2Control?.mode || 'simulation',
                real_available: ros2Control?.real_available === true,
                state: rosState,
            };
        } catch (e) {
            ros2Health.error = e.message;
        }

        // Check Recorrido
        let recorridoHealth = { available: false };
        try {
            const recEstado = recorridoService?.obtenerEstado?.();
            recorridoHealth = {
                available: !!recEstado,
                estado: recEstado,
            };
        } catch (e) {
            recorridoHealth.error = e.message;
        }

        const overall = memHealth.overall !== false && llmHealth.active !== 'unknown'
            && asrHealth.whisper !== false;
        orchestratorHealth.available = orchestratorHealth.dialogue === true;

        res.json({
            status: overall ? 'ok' : 'degraded',
            version: '3.0.0',
            timestamp: new Date().toISOString(),
            latency_ms: Date.now() - t0,
            databases: memHealth,
            llm: llmHealth,
            orchestrator: orchestratorHealth,
            tts: ttsHealth,
            asr: asrHealth,
            vision: visionHealth,
            ros2: ros2Health,
            recorrido: recorridoHealth,
            robot: robotStateManager.snapshot,
        });
    });

    // ── Menú ──────────────────────────────────────────────────
    app.get('/api/menu', async (req, res) => {
        try {
            const menu = await memoryService.obtenerMenu();
            res.json({ data: menu });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── FASE 6: navegación conversacional del menú + recomendaciones ───
    const { MenuNavigationService } = await import('./application/MenuNavigationService.mjs');
    const { fetchSalesByProduct } = await import('./application/MenuPopularityRepository.mjs');
    const buildMenuService = () => new MenuNavigationService({
        menu: orderSessionManager.getMenu(),
        memoryService,
        fetchSales: (period) => fetchSalesByProduct(getServices().pgPool, period),
        period: '30d',
    });

    app.get('/api/menu/categories', (req, res) => {
        try {
            const svc = buildMenuService();
            res.json({ data: svc.listCategories() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/menu/search', (req, res) => {
        try {
            const q = String(req.query.q || '').trim();
            const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 8));
            const svc = buildMenuService();
            res.json({ data: svc.searchProducts(q, { limit }), count: svc.searchProducts(q, { limit }).length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/menu/navigation', (req, res) => {
        try {
            const svc = buildMenuService();
            const data = svc.filterMenu({
                category: req.query.category || null,
                maxPrice: req.query.max_price || null,
                vegetarian: req.query.vegetarian || null,
                vegan: req.query.vegan || null,
                allergen: req.query.allergen || null,
                available: req.query.available || null,
                query: req.query.query || null,
            });
            res.json({ data, count: data.length, filters: req.query });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/menu/recommendations', async (req, res) => {
        try {
            const svc = buildMenuService();
            const sessionId = String(req.query.session_id || '');
            let declaredAllergies = [];
            let dietaryRestrictions = [];
            if (sessionId) {
                const session = orderSessionManager.get(sessionId);
                if (session) {
                    declaredAllergies = session.declared_allergies || [];
                    dietaryRestrictions = session.dietary_restrictions || [];
                }
            }
            const data = await svc.recommend({
                category: req.query.category || null,
                maxPrice: req.query.max_price || null,
                period: req.query.period || '30d',
                limit: Math.min(10, Math.max(1, Number(req.query.limit) || 3)),
                declaredAllergies,
                dietaryRestrictions,
            });
            res.json(data);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/menu/popular', async (req, res) => {
        try {
            const svc = buildMenuService();
            const sessionId = String(req.query.session_id || '');
            let declaredAllergies = [];
            let dietaryRestrictions = [];
            if (sessionId) {
                const session = orderSessionManager.get(sessionId);
                if (session) {
                    declaredAllergies = session.declared_allergies || [];
                    dietaryRestrictions = session.dietary_restrictions || [];
                }
            }
            const data = await svc.popular({
                period: req.query.period || '30d',
                limit: Math.min(10, Math.max(1, Number(req.query.limit) || 3)),
                category: req.query.category || null,
                declaredAllergies,
                dietaryRestrictions,
            });
            res.json(data);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/menu/compare', (req, res) => {
        try {
            const ids = String(req.query.ids || '').split(',').map(id => id.trim()).filter(Boolean);
            const svc = buildMenuService();
            const data = svc.compareProducts(ids);
            res.json(data);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/menu/dietary', (req, res) => {
        try {
            const svc = buildMenuService();
            const data = svc.dietaryOptions({
                restriction: req.query.restriction || null,
                limit: Math.min(20, Math.max(1, Number(req.query.limit) || 10)),
            });
            res.json(data);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── Mesas disponibles ───────────────────────────────────
    app.get('/api/mesas', async (req, res) => {
        try {
            const mesas = await tableService.listTables({ enabled: true });
            res.json({ data: mesas.map(projectPublicTableAvailability) });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    app.use('/api/tables', createTablesRouter(tableService));

    // ── Pedidos ───────────────────────────────────────────────
    app.get('/api/pedidos', adminAuth, async (req, res) => {
        try {
            const requestedLimit = Number(req.query.limit);
            const requestedOffset = Number(req.query.offset);
            const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 50;
            const offset = Number.isInteger(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
            const { data, total } = await memoryService.pedidoRepo.findAll(req.query, { limit, offset, orderBy: 'timestamp DESC' });
            res.json({ data, total, limit, offset });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/pedidos', (req, res, next) => {
        if (isAdminOrderMode(req.body)) return adminAuth(req, res, next);
        const sessionId = String(req.body?.session_id || '').trim();
        const session = sessionLifecycle?.get(sessionId);
        const suppliedToken = String(req.get('x-session-token') || '');
        if (!sessionId || !session?.session_access_token || suppliedToken !== session.session_access_token) {
            return res.status(401).json({ error: 'Token de sesión requerido.', code: 'SESSION_ACCESS_REQUIRED' });
        }
        const binding = bindCustomerOrderToSession(req.body, session);
        if (!binding.ok) {
            const status = binding.code === 'SESSION_ACCESS_REQUIRED' ? 401
                : binding.code === 'STALE_SESSION' ? 410
                    : binding.code === 'ORDER_LOCKED' ? 409 : 400;
            return res.status(status).json({ error: binding.message, code: binding.code });
        }
        req.body = binding.body;
        return next();
    }, async (req, res) => {
        try {
            const body = { ...req.body };
            const explicitAdditional = body.additional_order === true || body.order_kind === 'additional';
            // La etiqueta de QA nunca proviene del cliente del robot. Los
            // fixtures administrativos se crean en el servicio de historial.
            for (const protectedField of ['is_test', 'archived_at', 'archived_by', 'archive_reason', 'deleted_at', 'deletion_reason', 'retention_class', 'data_origin']) {
                delete body[protectedField];
            }
            body.is_test = false;
            body.data_origin = 'customer_order';
            body.retention_class = 'operational';
            delete body.order_sequence;
            delete body.order_kind;
            const incomingItems = Array.isArray(body.items) ? body.items : Array.isArray(body.platos) ? body.platos : [];
            if (body.mesa || body.table_id) {
                const normalizedTable = normalizeMesa(body.table_id || body.mesa);
                const table = await tableService.getTable(normalizedTable);
                if (!table || !table.enabled) return res.status(409).json({ error: `La mesa ${normalizedTable} no está disponible.`, code: 'TABLE_DISABLED' });
                const requestedVisitId = body.visit_id || null;
                if (table.current_visit_id && requestedVisitId && requestedVisitId !== table.current_visit_id) {
                    return res.status(409).json({ error: `La visita indicada para ${normalizedTable} ya no está activa.`, code: 'STALE_VISIT' });
                }
                if (table.current_visit_id && requestedVisitId && !explicitAdditional
                    && table.active_session_id !== body.session_id) {
                    return res.status(409).json({ error: `La mesa ${normalizedTable} ya tiene una atención activa. Usa el flujo explícito de pedido adicional.`, code: 'TABLE_OCCUPIED' });
                }
                if (table.current_visit_id && !explicitAdditional && !requestedVisitId) {
                    return res.status(409).json({ error: `La mesa ${normalizedTable} ya tiene una atención activa. Usa el flujo de pedido adicional.`, code: 'TABLE_OCCUPIED' });
                }
                if (table.current_visit_id && explicitAdditional) body.visit_id = table.current_visit_id;
                body.mesa = normalizedTable;
                body.table_id = normalizedTable;
            }
            if (!body.status && !body.estado) body.status = 'draft';
            const requestedStatus = body.status || body.estado || 'sent_to_kitchen';
            if (incomingItems.length > 0) {
                const validation = orderSessionManager.validateProducts(incomingItems);
                if (validation.invalidos.length || validation.agotados.length || validation.invalid_modifiers?.length) {
                    return res.status(400).json({ error: 'El pedido contiene productos o modificadores que no están en el menú real', validation });
                }
                body.items = validation.validos;
                body.platos = validation.validos;
                const realTotal = orderSessionManager.calculateTotal(validation.validos);
                body.subtotal = realTotal;
                body.total = realTotal;
            }
            const safety = fase5SafetyService.derive(incomingItems, orderSessionManager.getMenu(), body);
            if (['sent_to_kitchen', 'confirmed'].includes(body.status || body.estado)
                && safety.requires_special_confirmation
                && body.special_confirmation?.decision !== 'confirmed') {
                return res.status(409).json({ error: 'Se requiere confirmación especial antes de enviar este pedido', code: 'SPECIAL_CONFIRMATION_REQUIRED', safety });
            }
            Object.assign(body, safety);
            if (!body.id) body.id = randomUUID();
            if (!body.timestamp) body.timestamp = new Date().toISOString();
            if (!body.mode && !body.modo) body.mode = 'tablet';
            const tableOrder = Boolean(tableService && body.table_id);
            if (tableOrder) body.status = 'draft';
            let pedido = await memoryService.crearPedido(body);
            try {
                if (tableOrder) {
                    pedido = await tableService.attachOrder({ order: { ...pedido, additional_order: explicitAdditional }, source: 'admin_order' });
                    if (requestedStatus !== 'draft') {
                        pedido = await memoryService.pedidoRepo.update(pedido.id, { status: requestedStatus });
                        pedido = await tableService.syncOrderStatus({ order: pedido, source: 'admin_order' });
                    }
                }
            } catch (linkError) {
                if (tableOrder && pedido?.status === 'draft' && memoryService.pedidoRepo.deleteDraft) {
                    await memoryService.pedidoRepo.deleteDraft(pedido.id).catch(() => {});
                }
                throw linkError;
            }
            sendToUI({ type: 'nuevo_pedido', pedido });
            res.status(201).json(pedido);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.get('/api/pedidos/activos', adminAuth, async (req, res) => {
        try {
            const pedidos = tableService
                ? await tableService.listKitchenOrders({ statuses: ['sent_to_kitchen', 'preparing', 'ready'] })
                : await memoryService.listarPedidosActivos();
            res.json({ data: pedidos, total: pedidos.length });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.put('/api/pedidos/:id', adminAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const current = await memoryService.pedidoRepo.findById(id);
            if (!current) return res.status(404).json({ error: 'pedido no encontrado' });
            const updates = { ...(req.body || {}) };
            const currentStatus = current.status || current.estado;
            const requestedStatus = updates.status || updates.estado;
            if (requestedStatus && requestedStatus !== currentStatus
                && !['draft', 'pending_confirmation', 'provisional'].includes(currentStatus)) {
                return res.status(409).json({ error: 'Solo un borrador puede modificarse desde esta ruta.', code: 'ORDER_LOCKED', status: currentStatus });
            }
            const incomingItems = Array.isArray(updates.items) ? updates.items : Array.isArray(updates.platos) ? updates.platos : (current.items || current.platos || []);
            const validation = orderSessionManager.validateProducts(incomingItems);
            if (validation.invalidos.length || validation.agotados.length || validation.invalid_modifiers?.length) {
                return res.status(400).json({ error: 'El pedido contiene productos o modificadores que no están en el menú real', validation });
            }
            updates.items = validation.validos;
            updates.platos = validation.validos;
            updates.subtotal = orderSessionManager.calculateTotal(validation.validos);
            updates.total = updates.subtotal;
            const safety = fase5SafetyService.derive(validation.validos, orderSessionManager.getMenu(), { ...current, ...updates });
            const nextStatus = updates.status || updates.estado || current.status;
            if (['sent_to_kitchen', 'confirmed'].includes(nextStatus)
                && safety.requires_special_confirmation
                && (updates.special_confirmation || current.special_confirmation)?.decision !== 'confirmed') {
                return res.status(409).json({ error: 'Se requiere confirmación especial antes de enviar este pedido', code: 'SPECIAL_CONFIRMATION_REQUIRED', safety });
            }
            Object.assign(updates, safety);
            let pedido = await memoryService.pedidoRepo.update(id, updates);
            if (pedido && tableService && pedido.table_id) {
                pedido = await tableService.attachOrder({ order: pedido, source: 'admin_order_update' });
                await tableService.syncOrderStatus({ order: pedido, source: 'admin_order_update' });
            }
            sendToUI({ type: 'pedido_actualizado', pedido });
            res.json(pedido);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post('/api/pedidos/:id/confirmar', adminAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const current = await memoryService.pedidoRepo.findById(id);
            if (!current) return res.status(404).json({ error: 'pedido no encontrado' });
            if (['sent_to_kitchen', 'preparing', 'ready', 'delivered'].includes(current.status)) {
                return res.json(current);
            }
            const items = current.items || current.platos || [];
            const safety = fase5SafetyService.derive(items, orderSessionManager.getMenu(), current);
            if (safety.requires_special_confirmation && req.body?.special_confirmation?.decision !== 'confirmed' && current.special_confirmation?.decision !== 'confirmed') {
                return res.status(409).json({ error: 'Se requiere confirmación especial antes de enviar este pedido', code: 'SPECIAL_CONFIRMATION_REQUIRED', safety });
            }
            let pedido = await memoryService.pedidoRepo.update(id, { status: 'sent_to_kitchen', ...safety, special_confirmation: req.body?.special_confirmation || current.special_confirmation || {} });
            if (!pedido) return res.status(404).json({ error: 'pedido no encontrado' });
            if (tableService && pedido.table_id) pedido = await tableService.syncOrderStatus({ order: pedido, source: 'admin_order_confirm' });
            sendToUI({ type: 'pedido_actualizado', pedido });
            res.json(pedido);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.post('/api/pedidos/:id/cancelar', adminAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const current = await memoryService.pedidoRepo.findById(id);
            if (!current) return res.status(404).json({ error: 'pedido no encontrado' });
            if (!['draft', 'pending_confirmation', 'provisional'].includes(current.status)) {
                return res.status(409).json({ error: 'Solo se pueden cancelar pedidos en borrador.', code: 'ORDER_LOCKED', status: current.status });
            }
            let pedido = await memoryService.pedidoRepo.updateIfStatus(id, current.status, { status: 'cancelled' });
            if (!pedido) return res.status(404).json({ error: 'pedido no encontrado' });
            if (tableService && pedido.table_id) pedido = await tableService.syncOrderStatus({ order: pedido, source: 'admin_order_cancel' });
            sendToUI({ type: 'pedido_actualizado', pedido });
            res.json(pedido);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    // ── Memoria del cliente (usado por PLN) ───────────────────
    app.get('/api/memory/:clientId', async (req, res) => {
        try {
            const { clientId } = req.params;
            const { sqlite: db, pgPool } = getServices();

            const clienteRow = db.prepare(
                'SELECT id, nombre, preferencias, frecuencia, ultima_visita FROM clientes WHERE id = ?'
            ).get(clientId);

            const pgResult = await pgPool.query(
                `SELECT id, mesa, platos, bebida, total, estado, notas, timestamp
                 FROM pedidos
                 WHERE cliente_id = $1
                 ORDER BY timestamp DESC
                 LIMIT 10`,
                [clientId]
            );
            const pedidosRows = pgResult.rows;

            let preferenciasTexto = [];
            if (clienteRow?.preferencias) {
                try {
                    preferenciasTexto = JSON.parse(clienteRow.preferencias);
                } catch {
                    preferenciasTexto = [clienteRow.preferencias];
                }
            }

            const ultimosPedidos = pedidosRows.map(p => {
                let platos = p.platos;
                if (typeof platos === 'string') {
                    try { platos = JSON.parse(platos); } catch { /* leave as-is */ }
                }
                return {
                    id: p.id,
                    mesa: p.mesa,
                    platos,
                    bebida: p.bebida,
                    total: parseFloat(p.total),
                    estado: p.estado,
                    timestamp: p.timestamp,
                };
            });

            res.json({
                cliente: clienteRow
                    ? {
                        id: clienteRow.id,
                        nombre: clienteRow.nombre,
                        preferencias: preferenciasTexto,
                        frecuencia: clienteRow.frecuencia,
                        ultima_visita: clienteRow.ultima_visita,
                    }
                    : { id: clientId, nombre: null, preferencias: [], frecuencia: 0, ultima_visita: null },
                ultimos_pedidos: ultimosPedidos,
                total_pedidos: ultimosPedidos.length,
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/clientes', async (req, res) => {
        try {
            const { id, nombre, preferencias } = req.body;
            if (!id) return res.status(400).json({ error: 'id is required' });
            const { sqlite: db } = getServices();
            const now = new Date().toISOString();
            db.prepare(`
                INSERT INTO clientes (id, nombre, preferencias, frecuencia, ultima_visita)
                VALUES (?, ?, ?, 1, ?)
                ON CONFLICT(id) DO UPDATE SET
                    nombre = COALESCE(excluded.nombre, clientes.nombre),
                    preferencias = COALESCE(excluded.preferencias, clientes.preferencias),
                    frecuencia = clientes.frecuencia + 1,
                    ultima_visita = excluded.ultima_visita
            `).run(id, nombre || null, preferencias ? JSON.stringify(preferencias) : null, now);
            const row = db.prepare('SELECT id, nombre, preferencias, frecuencia, ultima_visita FROM clientes WHERE id = ?').get(id);
            sendToUI({ type: 'cliente_actualizado', cliente: row });
            res.status(200).json(row);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get('/api/clientes/:clientId', async (req, res) => {
        try {
            const { sqlite: db } = getServices();
            const row = db.prepare('SELECT id, nombre, preferencias, frecuencia, ultima_visita FROM clientes WHERE id = ?').get(req.params.clientId);
            res.json(row || { id: req.params.clientId, nombre: null, preferencias: null, frecuencia: 0, ultima_visita: null });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ── Cocina (KDS) ──────────────────────────────────────────
    app.get('/api/cocina/cola', adminAuth, async (req, res) => {
        try {
            const [enPrep, listos, enviados, ...legacyTotals] = await Promise.all([
                tableService.listKitchenOrders({ statuses: ['preparing'] }),
                tableService.listKitchenOrders({ statuses: ['ready'] }),
                tableService.listKitchenOrders({ statuses: ['sent_to_kitchen'] }),
                ...['preparing', 'ready', 'sent_to_kitchen'].map(status => memoryService.pedidoRepo.findAll({ status }, { limit: 1 })),
            ]);
            const activeCount = enPrep.length + listos.length + enviados.length;
            const totalCount = legacyTotals.reduce((sum, result) => sum + Number(result.total || 0), 0);
            res.json({
                enviados: enviados.map(projectKitchenOrder),
                en_preparacion: enPrep.map(projectKitchenOrder),
                listos: listos.map(projectKitchenOrder),
                legacy_count: Math.max(0, totalCount - activeCount),
                legacy_note: 'Pedidos fuera de una visita activa se conservan en historial y requieren reconciliación administrativa.',
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/cocina/pedido/:id/preparar', adminAuth, async (req, res) => {
        try {
            const current = await memoryService.pedidoRepo.findById(req.params.id);
            if (!current) return res.status(404).json({ error: 'Pedido no encontrado', code: 'ORDER_NOT_FOUND' });
            if (!(await tableService.isCurrentOrder(current))) {
                return res.status(409).json({ error: 'El pedido no pertenece a una visita activa.', code: 'STALE_VISIT' });
            }
            let pedido = typeof memoryService.pedidoRepo.updateIfStatus === 'function'
                ? await memoryService.pedidoRepo.updateIfStatus(req.params.id, 'sent_to_kitchen', { status: 'preparing' })
                : null;
            if (!pedido) {
                return res.status(409).json({
                    error: `El pedido no puede pasar a preparación desde ${current.status}.`,
                    code: 'ORDER_STATE_CONFLICT',
                    status: current.status,
                });
            }
            pedido = await tableService.syncOrderStatus({ order: pedido, source: 'cocina_preparing' });
            sendToUI({ type: 'pedido_actualizado', pedido });
            res.json(pedido);
        } catch (e) {
            res.status(e.code === 'ORDER_STATE_CONFLICT' ? 409 : 500).json({ error: e.message, code: e.code });
        }
    });

    app.post('/api/cocina/pedido/:id/listo', adminAuth, async (req, res) => {
        try {
            const current = await memoryService.pedidoRepo.findById(req.params.id);
            if (!current) return res.status(404).json({ error: 'Pedido no encontrado', code: 'ORDER_NOT_FOUND' });
            if (!(await tableService.isCurrentOrder(current))) {
                return res.status(409).json({ error: 'El pedido no pertenece a una visita activa.', code: 'STALE_VISIT' });
            }
            let pedido = typeof memoryService.pedidoRepo.updateIfStatus === 'function'
                ? await memoryService.pedidoRepo.updateIfStatus(req.params.id, 'preparing', { status: 'ready' })
                : null;
            if (!pedido) {
                return res.status(409).json({
                    error: `El pedido no puede marcarse listo desde ${current.status}.`,
                    code: 'ORDER_STATE_CONFLICT',
                    status: current.status,
                });
            }
            pedido = await tableService.syncOrderStatus({ order: pedido, source: 'cocina_ready' });
            sendToUI({ type: 'pedido_listo', pedido });
            res.json(pedido);
        } catch (e) {
            res.status(e.code === 'ORDER_STATE_CONFLICT' ? 409 : 500).json({ error: e.message, code: e.code });
        }
    });

    // ── Recorrido ─────────────────────────────────────────────
    app.post('/api/recorrido/iniciar', adminAuth, async (req, res) => {
        try {
            const { pedidoId, mesa } = req.body;
            const estado = await recorridoService.iniciarRecorrido(pedidoId, mesa);
            res.json(estado);
        } catch (e) {
            res.status(400).json({ error: e.message });
        }
    });

    app.get('/api/recorrido/estado', async (req, res) => {
        res.json(recorridoService.obtenerEstado());
    });

    // ── Robot State ───────────────────────────────────────────
    app.get('/api/robot/estado', async (req, res) => {
        const rosState = await ros2Control.getState();
        let snapshot = robotStateManager.snapshot;
        const sessionById = snapshot.current_session_id ? sessionLifecycle?.get?.(snapshot.current_session_id) : null;
        const activeSession = sessionById && !['closed', 'expired'].includes(sessionById.session_status)
            ? sessionById
            : sessionLifecycle?.getActiveSessionForRobot?.(snapshot.robot_id) || null;
        if (snapshot.current_session_id && !activeSession
            && ['assigned', 'navigating_to_table', 'attending', 'waiting_for_human_waiter'].includes(snapshot.state)) {
            robotStateManager.release({ reason: 'stale_session_reconciled' });
            snapshot = robotStateManager.snapshot;
        }
        res.json({
            ...rosState,
            ...snapshot,
            robot_state: snapshot.state,
            is_staff: isStaffMode,
            physical_state: rosState,
        });
    });

    app.post('/api/esp32/test-tone', async (req, res) => {
        try {
            const result = hardwareControl.sendTestTone(req.body || {});
            pushAudioLabEvent('speaker_test_tone', req.body || {});
            emitAudioLabMetrics();
            res.json(result);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    // ── Speak: TTS + send to ESP32 in one call ──
    app.post('/api/esp32/speak', async (req, res) => {
        const { text } = req.body || {};
        if (!text || !text.trim()) {
            return res.status(400).json({ error: 'text is required' });
        }
        try {
            const t0 = Date.now();
            // 1. Get TTS from Kokoro server directly (port 3500)
            const ttsResp = await fetch('http://127.0.0.1:3500/speak', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text.trim(), use_rvc: false, emotion: 'pensando' }),
                signal: AbortSignal.timeout(10000),
            });
            if (!ttsResp.ok) {
                return res.status(502).json({ error: `TTS server ${ttsResp.status}` });
            }
            const ttsData = await ttsResp.json();
            if (!ttsData.wav_base64) {
                return res.status(502).json({ error: 'TTS returned no audio' });
            }
            // 2. Decode WAV → 16kHz mono PCM using ffmpeg (high-quality resampling)
            const wavBuf = Buffer.from(ttsData.wav_base64, 'base64');
            const tmpWav = '/tmp/speak_input.wav';
            const tmpPcm = '/tmp/speak_output.pcm';
            const { writeFileSync, readFileSync, unlinkSync } = await import('fs');
            writeFileSync(tmpWav, wavBuf);
            const { execSync } = await import('child_process');
            execSync(`ffmpeg -y -i "${tmpWav}" -ar 16000 -ac 1 -f s16le "${tmpPcm}" 2>/dev/null`, { timeout: 5000 });
            const rawPcm = readFileSync(tmpPcm);
            try { unlinkSync(tmpWav); } catch {}
            try { unlinkSync(tmpPcm); } catch {}
            if (!rawPcm || rawPcm.length === 0) {
                return res.status(500).json({ error: 'PCM conversion failed' });
            }
            // Amplify 3x with clipping protection (Kokoro RMS is ~5%, too quiet)
            const pcm = Buffer.alloc(rawPcm.length);
            const gain = Number(process.env.UCHINO_SPEAKER_GAIN) || 3;
            for (let i = 0; i < rawPcm.length - 1; i += 2) {
                let s = rawPcm.readInt16LE(i) * gain;
                s = Math.max(-32768, Math.min(32767, s));
                pcm.writeInt16LE(s, i);
            }
            // 3. Send to ESP32 via hardwareControl (TCP sink) with 50ms gap between chunks
            //    Long audio floods ESP32 buffer — need pacing
            const CHUNK_MS = 80; // ms delay between chunks (each chunk ~1s of audio)
            const sent = await hardwareControl.sendPcmPaced(pcm, CHUNK_MS);
            const durationMs = Math.round(pcm.length / 32000 * 1000);
            logger.log(`[SPEAK] "${text.slice(0, 40)}" → ${pcm.length} bytes (${durationMs}ms) → ${sent} sink(s) (+${Date.now() - t0}ms)`);
            res.json({ ok: true, bytes: pcm.length, duration_ms: durationMs, sinks: sent, elapsed_ms: Date.now() - t0 });
        } catch (e) {
            logger.error('[SPEAK] Error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/esp32/volume', async (req, res) => {
        try {
            const result = hardwareControl.setAudioVolume(req.body?.volume);
            pushAudioLabEvent('speaker_volume_changed', { volume: result.audio_volume });
            emitAudioLabMetrics();
            res.json(result);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    /**
     * POST /api/esp32/ota
     * Recibe un binario de firmware y lo envía al ESP32 vía OTA sobre TCP.
     * Body: raw binary (Content-Type: application/octet-stream)
     * Query params: chunk_size (opcional, default 4096)
     */
    app.post('/api/esp32/ota', async (req, res) => {
        try {
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', async () => {
                const firmwareBuf = Buffer.concat(chunks);
                if (firmwareBuf.length < 1024) {
                    return res.status(400).json({ error: 'Firmware demasiado pequeño: ' + firmwareBuf.length + ' bytes' });
                }
                logger.log('[OTA] Recibido firmware:', firmwareBuf.length, 'bytes');
                const t0 = Date.now();
                const chunkSize = parseInt(req.query.chunk_size) || 4096;
                const sent = await hardwareControl.sendOtaFirmware(firmwareBuf, chunkSize);
                logger.log('[OTA] Completado:', firmwareBuf.length, 'bytes,', Date.now() - t0, 'ms');
                res.json({ ok: true, bytes: firmwareBuf.length, elapsed_ms: Date.now() - t0, sent_to_sinks: sent });
            });
        } catch (error) {
            logger.error('[OTA] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    app.get('/api/audio-lab/status', async (req, res) => {
        const t0 = Date.now();
        let services = null;
        let error = null;
        try {
            const memHealth = await memoryService.healthCheck().catch(() => ({}));
            services = {
                databases: memHealth,
                llm: {
                    primary: !!llmOrchestrator.primary?.getModelInfo?.(),
                    fallback: !!llmOrchestrator.fallback?.getModelInfo?.(),
                    onFallback: !!llmOrchestrator.onFallback,
                },
                orchestrator: { url: ORCHESTRATOR_URL },
                tts: { piper: !!piperTTS?.disponible, python_ready: ttsReady },
                asr: { whisper: !!whisperASR?.disponible },
                audio_lab: { esp32_pcm_bypassed: AUDIO_LAB_ISOLATE_ESP32_PCM },
                vision: { available: !!visionManager, mockMode: visionManager?.mockMode || false },
            };
        } catch (e) {
            error = e.message;
        }

        res.json({
            ok: !error,
            latency_ms: Date.now() - t0,
            error,
            services,
            snapshot: getAudioLabSnapshot(),
        });
    });

    app.post('/api/audio-lab/reset', async (req, res) => {
        audioLabState.telemetry = null;
        audioLabState.lastAsrPartial = '';
        audioLabState.lastAsrFinal = '';
        audioLabState.lastResponseText = '';
        audioLabState.conversationState = 'IDLE';
        audioLabState.tts = {
            chunks: 0,
            bytes: 0,
            durationMs: 0,
            lastSentAt: null,
        };
        audioLabState.uplink = {
            pcmFrames: 0,
            pcmBytes: 0,
            lastFrameAt: null,
            lastFrameType: null,
            backendPcmBypassed: AUDIO_LAB_ISOLATE_ESP32_PCM,
        };
        audioLabState.events = [];
        pushAudioLabEvent('metrics_reset');
        emitAudioLabMetrics();
        res.json({ ok: true });
    });

    // ── Vision ─────────────────────────────────────────────────
    app.post('/api/vision/query', async (req, res) => {
        try {
            const { prompt, frame_source } = req.body;
            if (!prompt || typeof prompt !== 'string') {
                return res.status(400).json({ error: 'prompt (string) is required' });
            }
            const result = await visionManager.queryVision({
                prompt,
                frameSource: frame_source || 'rgb',
            });
            res.json(result);
        } catch (e) {
            logger.error('[VISION] Query error:', e.message);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.get('/api/vision/stats', async (req, res) => {
        res.json(visionManager.getStats());
    });

    app.get('/api/vision/capture', async (req, res) => {
        try {
            const frame = await visionManager._captureFrame();
            if (!frame) return res.status(503).json({ success: false, error: 'No frame available' });
            res.json({
                success: true,
                width: frame.width,
                height: frame.height,
                image_base64: frame.image_base64,
                source: frame.source,
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ── TTS Speak (Kokoro + optional Auron RVC) ────────────────
    app.post('/api/tts/speak', async (req, res) => {
        const { text, emotion, use_rvc } = req.body || {};
        if (!text || !text.trim()) {
            return res.status(400).json({ error: 'text is required' });
        }
        try {
            if (!ttsReady) {
                return res.status(503).json({ error: 'TTS server starting...' });
            }
            const prepared = speechPlayback.prepare(text.trim(), { source: 'tts_api' });
            if (!prepared.speechText) return res.status(400).json({ error: 'text has no speakable content' });
            const result = await ttsRequest(prepared.speechText, emotion || null, !!use_rvc);
            if (result.error) {
                return res.status(500).json({ error: result.error });
            }
            // Return raw WAV audio for direct &lt;audio&gt; playback
            const wavBuffer = Buffer.from(result.wav_base64, 'base64');
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('X-TTS-Engine', result.engine || 'kokoro');
            res.setHeader('X-TTS-Emotion', result.emotion_tag || emotion || 'feliz');
            res.setHeader('X-TTS-Duration', String(result.duration_s || 0));
            res.setHeader('X-Speech-Segments', String(prepared.segments.length));
            res.send(wavBuffer);
        } catch (e) {
            logger.error('[TTS] speak error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ── TTS Speak JSON (for API clients that want metadata) ──
    app.post('/api/tts/speak-json', async (req, res) => {
        const { text, emotion, use_rvc } = req.body || {};
        if (!text || !text.trim()) {
            return res.status(400).json({ error: 'text is required' });
        }
        try {
            if (!ttsReady) {
                return res.status(503).json({ error: 'TTS server starting...' });
            }
            const prepared = speechPlayback.prepare(text.trim(), { source: 'tts_api_json' });
            if (!prepared.speechText) return res.status(400).json({ error: 'text has no speakable content' });
            const result = await ttsRequest(prepared.speechText, emotion || null, !!use_rvc);
            if (result.error) {
                return res.status(500).json({ error: result.error });
            }
            res.json({ success: true, ...result, ...speechPayload(prepared) });
        } catch (e) {
            logger.error('[TTS] speak-json error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ── Admin Dashboard API (JWT auth) ────────────────────────

    // ── HRI: Staff mode toggle (protected by admin auth middleware) ──
    app.post('/api/admin/staff-mode', adminAuth, (req, res) => {
        const { enabled } = req.body || {};
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled (boolean) is required' });
        }
        isStaffMode = enabled;
        sendToUI({ type: 'staff_mode_changed', enabled: isStaffMode, timestamp: new Date().toISOString() });
        logger.log(`[STAFF] Staff mode ${isStaffMode ? 'enabled' : 'disabled'}`);
        res.json({ ok: true, staff_mode: isStaffMode });
    });

    app.post('/api/admin/robot-command', adminAuth, (req, res) => {
        const command = String(req.body?.command || '').trim().toLowerCase();
        const handlers = {
            pause: () => robotStateManager.pause({ reason: 'admin' }),
            resume: () => robotStateManager.resume(),
            emergency: () => robotStateManager.emergencyStop({ reason: 'admin' }),
            release: () => robotStateManager.release({ reason: 'admin' }),
        };
        if (!handlers[command]) {
            return res.status(400).json({ error: 'Comando no permitido.', code: 'INVALID_ROBOT_COMMAND' });
        }
        const result = handlers[command]();
        if (!result.ok) {
            return res.status(409).json({ error: result.error, code: 'ROBOT_STATE_CONFLICT', state: result.state });
        }
        return res.json({ ok: true, command, state: result.state });
    });

    app.use('/api/admin', createAdminRouter(orderSessionManager, tableService));
    app.use('/api/admin', createAdminHistoryRouter(orderHistoryService));
    app.use('/api/admin/analytics', createAdminAnalyticsRouter(analyticsService));
    app.use('/api/admin/memory', adminAuth, createAdminMemoryRouter(temporaryMemoryService));

    // ── LLM Bridge (Python dialogue ↔ Node.js orchestrator) ───
    app.use('/api/llm', createLlmBridgeRouter(llmOrchestrator, memoryService, temporaryMemoryService, () => sessionLifecycle));

    // ── FASE 7: Session Lifecycle (inicio/cierre/reinicio por mesa) ──
    sessionLifecycle = new SessionLifecycleService({
        orderSessionManager,
        memoryService,
        sendToUI,
        safetyService: getServices().fase5SafetyService,
        pool: getServices().pgPool || null,
        stopSessionAudio: ({ reason } = {}) => speechPlayback?.cancel({ reason: reason || 'session_closed' }),
        inactivityWarningMs: Number(process.env.SESSION_INACTIVITY_WARNING_MS) || 60_000,
        inactivityCloseMs: Number(process.env.SESSION_INACTIVITY_CLOSE_MS) || 30_000,
        logger: getServices().logger || console,
    });
    tableService.setSessionLifecycle(sessionLifecycle);
    tableService.setRobotStateManager?.(robotStateManager);
    sessionLifecycle.setSessionClosedHandler?.((session, context) => {
        const closeContext = context || {};
        const detach = tableService.detachSession(session?.session_id, closeContext);
        const clearMemory = temporaryMemoryService?.clearSession?.(session?.session_id);
        const closeEmptyVisit = ['user_cancelled_order', 'user_cancelled_attention', 'no_order', 'inactivity_timeout'].includes(closeContext.reason)
            || (closeContext.reason === 'human_waiter_requested' && !session?.active_order_id);
        const shouldCloseVisit = closeEmptyVisit
            && session?.mesa
            && session?.visit_id;
        if (!shouldCloseVisit) return Promise.all([detach, clearMemory]).then(([result]) => result);
        return Promise.resolve(detach).then(() => tableService.closeVisit({
            tableId: session.mesa,
            visitId: session.visit_id,
            source: closeContext.source || 'session_closed',
            reason: closeContext.reason,
            force: false,
        })).catch(error => logger.warn?.(`[SESSION] visita no cerrada automáticamente: ${error.message}`))
            .then(result => Promise.resolve(clearMemory).then(() => result));
    });
    // Conectar ciclo de sesión conversacional con estado físico del robot
    sessionLifecycle.setRobotTransitionHandler?.(({ action, robotId, mesa, sessionId, visitId }) => {
        if (action === 'assigned' && mesa) {
            const result = robotStateManager.assignToTable({ mesa, visitId, sessionId, source: 'session_lifecycle' });
            if (result.ok) {
                const navigating = robotStateManager.startNavigatingToTable();
                if (navigating.ok) {
                    const arrived = robotStateManager.arriveAtTable({ mesa, visitId, sessionId });
                    if (arrived.ok) robotStateManager.startAttending({ mesa, visitId, sessionId });
                }
            }
        } else if (action === 'moved' && mesa) {
            const result = robotStateManager.moveAttention({ mesa, visitId, sessionId });
            if (!result.ok) logger.warn(`[RobotState] No se pudo actualizar mesa tras movimiento: ${result.error}`);
            return result;
        } else if (action === 'visit_attached' && mesa) {
            const result = robotStateManager.syncAttentionContext({ mesa, visitId, sessionId });
            if (!result.ok) logger.warn(`[RobotState] No se pudo sincronizar visita: ${result.error}`);
            return result;
        } else if (action === 'released') {
            return robotStateManager.release({ reason: 'session_closed' });
        }
        return { ok: true, state: robotStateManager.snapshot };
    });
    waiterAssistanceService?.setRequestHandler?.((request) => {
        if (request.robot_id && request.robot_id !== robotStateManager.robotId) return;
        const session = orderSessionManager.get(request.session_id);
        if (session && ['closed', 'expired'].includes(session.session_status)) return;
        const result = robotStateManager.waitForHumanWaiter({
            mesa: request.mesa,
            visitId: request.visit_id,
            sessionId: request.session_id,
        });
        if (!result.ok) logger.warn(`[RobotState] No se pudo pasar a espera de mesero: ${result.error}`);
    });
    waiterAssistanceService?.setUpdateHandler?.((request) => {
        if (request.status !== 'attended') return;
        const snapshot = robotStateManager.snapshot;
        if (snapshot.current_session_id !== request.session_id) return;
        if (robotStateManager.state === RobotState.WAITING_FOR_HUMAN_WAITER) {
            robotStateManager.release({ reason: 'waiter_attended' });
        }
        const session = orderSessionManager.get(request.session_id);
        if (session && !['closed', 'expired', 'completing'].includes(session.session_status)) {
            sessionLifecycle.closeForHumanWaiter(request.session_id);
        }
    });
    ros2DeliverySimulator.setDeliveryStateHandler?.((snapshot) => tableService.handleDeliveryStateChange(snapshot));
    ros2DeliverySimulator.setSpeechHandler?.((payload, context = {}) => speechPlayback?.speak(payload, {
        source: context.source || 'ros2_simulation',
        sessionId: context.sessionId || null,
        orderId: context.orderId || payload?.order_id || null,
        mesa: context.mesa || null,
        emotion: context.emotion || 'feliz',
    }));
    app.use('/api/sessions', createSessionsRouter(sessionLifecycle, orderSessionManager, tableService, waiterAssistanceService));
    app.use('/api/memory', createMemoryRouter({ orderSessionManager, memoryService: temporaryMemoryService, sessionLifecycle }));

    // ── FASE 4: ASR Process (pedido por voz) ──────────────────
    app.use('/api/asr', createAsrProcessRouter(
        fase3Orchestrator,
        orderSessionManager,
        memoryService,
        sendToUI,
        localTtsPlayer,
        waiterAssistanceService,
        getServices().fase5SafetyService,
        getServices().pgPool || null,
        sessionLifecycle,
        tableService,
        temporaryMemoryService,
        speechPlayback,
    ));

    // Expone el lifecycle para que el handler /confirm pueda auto-cerrar.
    app.set('sessionLifecycle', sessionLifecycle);

    // ── FASE 5: TTS Speak (pruebas locales) ──────────────────
    app.post('/api/tts/speak-local', async (req, res) => {
        const { text, emotion } = req.body || {};
        if (!text) return res.status(400).json({ error: 'text required' });
        if (!localTtsPlayer || !localTtsPlayer.isReady) {
            return res.status(503).json({ error: 'TTS no disponible' });
        }
        const prepared = speechPlayback.prepare(text, { source: 'tts_speak_local' });
        const playback = speechPlayback.speak(prepared, {
            sanitized: true,
            source: 'tts_speak_local',
            emotion: emotion || 'feliz',
        });
        res.json({ success: true, id: playback.ids[0] || null, ...speechPayload(prepared) });
    });

    app.post('/api/tts/stop', (req, res) => {
        const sessionId = req.body?.session_id || null;
        speechPlayback.cancel({ reason: 'ui_stop', sessionId });
        res.json({ ok: true, stopped: true, session_id: sessionId });
    });

    app.post('/api/tts/repeat', (req, res) => {
        const sessionId = req.body?.session_id || null;
        if (!sessionId) return res.status(400).json({ error: 'session_id required' });
        const session = orderSessionManager.get(sessionId);
        if (!session || ['closed', 'expired'].includes(session.session_status)) {
            return res.status(410).json({ error: 'La sesión ya no está activa', code: 'SESSION_CLOSED' });
        }
        const playback = speechPlayback.repeatLast(sessionId, { source: 'ui_repeat' });
        if (playback.missing) return res.status(404).json({ error: 'No hay una respuesta para repetir' });
        res.json({ ok: true, ...speechPayload(playback.prepared), ids: playback.ids });
    });

    app.get('/api/tts/status', (req, res) => {
        res.json({
            ready: localTtsPlayer?.isReady || false,
            speaking: localTtsPlayer?.isSpeaking || false,
            mic_paused: micPaused || false,
        });
    });

    app.get('/api/admin/speech/diagnostics', adminAuth, (req, res) => {
        const diagnostics = speechPlayback.diagnostics();
        res.json({
            ok: true,
            tts_engine: diagnostics.ready ? 'local_tts_player' : 'unavailable',
            tts_status: diagnostics.ready ? (diagnostics.speaking ? 'speaking' : 'ready') : 'degraded',
            ready: diagnostics.ready,
            speaking: diagnostics.speaking,
            diagnostics,
            generated_at: new Date().toISOString(),
        });
    });

    app.post('/api/admin/speech/preview', adminAuth, (req, res) => {
        const { text, emotion } = req.body || {};
        if (typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ error: 'text is required' });
        }
        const prepared = speechPlayback.prepare(text, { source: 'admin_preview' });
        const playback = speechPlayback.speak(prepared, {
            sanitized: true,
            source: 'admin_preview',
            emotion: emotion || 'feliz',
        });
        return res.json({ ok: true, ...speechPayload(prepared), ids: playback.ids });
    });

    function checkFastRule(text) {
        if (!text) return null;
        const t = text.toLowerCase().trim();
        const intro = t.match(/\b(?:me llamo|mi nombre es|yo soy)\s+([a-záéíóúñü\s]+?)(?:\s*[,.\?!]|\s+y\s|\s*$|\s+por\s+favor)/i);
        if (intro) {
            const nombre = intro[1].trim().split(/\s+/).slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            return { text: `¡Mucho gusto, ${nombre}! Ya te tengo registrado. ¿Qué se te provoca hoy?`, introName: nombre };
        }
        const soyIntro = t.match(/^(?:buenas?\s+(?:tardes|días|noches)|hola|oe)\s*,?\s*soy\s+([a-záéíóúñü]+(?:\s+[a-záéíóúñü]+){0,2}?)(?:\s*[,.\?!]|\s+y\s+\w|\s+necesito|\s+quiero|\s+quisiera|\s+también|\s*$)/i);
        if (soyIntro) {
            const candidate = soyIntro[1].trim().split(/\s+/).slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
            if (!/^(un|una|el|la|de|del|al|y|o|pero|si|no|que|con|por|para)\b/i.test(candidate)) {
                return { text: `¡Mucho gusto, ${candidate}! Ya te tengo registrado. ¿Qué se te provoca hoy?`, introName: candidate };
            }
        }
        return null;
    }

    async function saveIntroName(clientId, text) {
        if (!clientId || !text) return;
        const fr = checkFastRule(text);
        if (!fr || !fr.introName) return;
        try {
            const { sqlite: db } = getServices();
            db.prepare(`
                INSERT INTO clientes (id, nombre, preferencias, frecuencia, ultima_visita)
                VALUES (?, ?, NULL, 1, ?)
                ON CONFLICT(id) DO UPDATE SET
                    nombre = COALESCE(excluded.nombre, clientes.nombre),
                    frecuencia = clientes.frecuencia + 1,
                    ultima_visita = excluded.ultima_visita
            `).run(clientId, fr.introName, new Date().toISOString());
            sendToUI({ type: 'cliente_actualizado', cliente: { id: clientId, nombre: fr.introName } });
            logger.log(`[INTRO] Client ${clientId} name saved: ${fr.introName}`);
        } catch (e) {
            logger.error(`[INTRO] Failed: ${e.message}`);
        }
    }

    // ── Test page (pipeline debug) ───────────────────────────
    app.get('/test_chipi', (_, res) => res.sendFile(join(__dirname, '../../frontend_ui/dist/test_chipi.html')));

    // Return 404 for missing assets/files instead of falling back to SPA index
    app.get('/assets/*', (_, res) => res.status(404).send('Asset Not Found'));

    // Fallback: SPA catch-all for unknown routes (MUST be last)
    app.get('*', (req, res) => {
        if (req.path.includes('.') || req.path.startsWith('/api/')) {
            return res.status(404).send('Not Found');
        }
        res.sendFile(join(__dirname, '../../frontend_ui/dist/robot.html'));
    });

    // ── Helpers: VAD & WAV ────────────────────────────────────
    function detectSilence(buffer, threshold = 500) {
        if (!buffer || buffer.length < 2) return true;
        let sum = 0;
        const samples = Math.floor(buffer.length / 2);
        for (let i = 0; i < samples; i++) {
            const sample = buffer.readInt16LE(i * 2);
            sum += sample * sample;
        }
        const rms = Math.sqrt(sum / samples);
        return rms < threshold;
    }

    function pcmToWav(pcmBuffer, sampleRate = 16000, channels = 2) {
        let pcm = pcmBuffer;
        if (channels === 2) {
            const mono = Buffer.alloc(Math.floor(pcmBuffer.length / 2));
            const samples = Math.floor(pcmBuffer.length / 4);
            for (let i = 0; i < samples; i++) {
                const left = pcmBuffer.readInt16LE(i * 4);
                const right = pcmBuffer.readInt16LE(i * 4 + 2);
                mono.writeInt16LE(Math.round((left + right) / 2), i * 2);
            }
            pcm = mono;
            channels = 1;
        }
        const bitsPerSample = 16;
        const blockAlign = channels * (bitsPerSample / 8);
        const byteRate = sampleRate * blockAlign;
        const dataSize = pcm.length;
        const wav = Buffer.alloc(44 + dataSize);
        wav.write('RIFF', 0);
        wav.writeUInt32LE(36 + dataSize, 4);
        wav.write('WAVE', 8);
        wav.write('fmt ', 12);
        wav.writeUInt32LE(16, 16);
        wav.writeUInt16LE(1, 20);
        wav.writeUInt16LE(channels, 22);
        wav.writeUInt32LE(sampleRate, 24);
        wav.writeUInt32LE(byteRate, 28);
        wav.writeUInt16LE(blockAlign, 32);
        wav.writeUInt16LE(bitsPerSample, 34);
        wav.write('data', 36);
        wav.writeUInt32LE(dataSize, 40);
        pcm.copy(wav, 44);
        return wav;
    }

    function normalizeTtsAudio(audioBuffer) {
        if (!audioBuffer || audioBuffer.length === 0) {
            return null;
        }
        if (audioBuffer.length >= 12 && audioBuffer.toString('ascii', 0, 4) === 'RIFF') {
            return wavToPcm16Mono16k(audioBuffer);
        }
        return audioBuffer;
    }

    function extractTtsBuffer(ttsPayload) {
        if (!ttsPayload) {
            return null;
        }
        if (typeof ttsPayload === 'string') {
            return Buffer.from(ttsPayload, 'base64');
        }
        if (ttsPayload.wav_base64) {
            return Buffer.from(ttsPayload.wav_base64, 'base64');
        }
        return null;
    }

    async function processVoiceTurn(state, audioWriter, whisperASR, llmOrchestrator, piperTTS, logger, deterministicVoiceTurn = null) {
        const t0 = Date.now();
        let allowCurrentTurnResponse = false;

        const rejectLateResponse = ({ includeTransportClosed = false, allowCurrentTurn = false } = {}) => {
            if (!state.sessionId) return true;
            if (includeTransportClosed && state.voiceSessionClosed && !allowCurrentTurn) return true;
            const session = orderSessionManager.get(state.sessionId);
            if (!session) {
                sendToUI({ type: 'late_response_rejected', session_id: state.sessionId, session_status: 'missing', timestamp: new Date().toISOString() });
                return true;
            }
            if (!isStaleSession(session) || allowCurrentTurn) return false;
            logger.warn(`[PIPELINE] Late response rejected: session ${state.sessionId} has status ${session.session_status}`);
            sendToUI({ type: 'late_response_rejected', session_id: state.sessionId, session_status: session.session_status, timestamp: new Date().toISOString() });
            return true;
        };

        // FASE 7: Reject responses for sessions already closed before work starts.
        if (rejectLateResponse({ includeTransportClosed: true })) return null;

        let asrText = null;
        let llmResult = null;
        let responseAudio = null;
        let emotion = null;
        const seq = state.lastSeq || 0;

        try {
            // 1. ASR: esperar hasta 2.5s a que Whisper confirme texto (SimulStreaming)
            if (whisperASR?.disponible && !state.ultimoTextoConfirmado) {
                logger.log('[PIPELINE] Esperando confirmación ASR de Whisper (hasta 2.5s)...');
                await new Promise(resolve => {
                    const maxWait = setTimeout(resolve, 2500);
                    const check = setInterval(() => {
                        if (state.ultimoTextoConfirmado) {
                            clearInterval(check);
                            clearTimeout(maxWait);
                            resolve();
                        }
                    }, 100);
                });
            }
            if (whisperASR?.disponible && state.ultimoTextoConfirmado) {
                logger.log('[PIPELINE] ASR (Streaming) texto capturado');
                asrText = state.ultimoTextoConfirmado;
                state.ultimoTextoConfirmado = null; // resetear
                audioLabState.lastAsrFinal = asrText;
                pushAudioLabEvent('asr_final', { text: asrText.slice(0, 160), clientId: state.clientId || null });
                logger.log('[PIPELINE] ASR result:', asrText, `(+${Date.now() - t0}ms)`);
            } else if (state.audioBuffer.length > 0) {
                logger.log('[PIPELINE] ASR vacío tras espera, usando fallback de audio.');
            }

            // 1.5. Fast rules (greeting, intro, farewell) — before LLM
            const fastResponse = checkFastRule(asrText);
            if (fastResponse) {
                if (fastResponse.introName && state.clientId) {
                    await saveIntroName(state.clientId, asrText);
                }
                llmResult = { text: fastResponse.text };
                audioLabState.lastResponseText = fastResponse.text;
                logger.log('[PIPELINE] Fast rule matched, skipping LLM:', fastResponse.text.slice(0, 60));
            }

            // 2. Pedido determinístico compartido | Python Orchestrator (social) | LLM directo (fallback)
            const t1 = Date.now();
            if (asrText && !llmResult) {
                const deterministic = deterministicVoiceTurn
                    ? await deterministicVoiceTurn(state, asrText)
                    : null;
                const orchestrated = deterministic || await tryOrchestrator(asrText, state.sessionId, {
                    wake_word_detected: state.wakeWordDetected,
                    mesa: state.mesa || null,
                });
                if (orchestrated) {
                    logger.log('[PIPELINE] Orchestrator result:', orchestrated.response_text?.slice(0, 80), `(+${Date.now() - t1}ms)`);
                    emotion = orchestrated.emotion;
                    llmResult = { text: orchestrated.response_text };
                    audioLabState.lastResponseText = orchestrated.response_text || '';
                    // El sidecar conserva su proveedor, pero en esta ruta Node
                    // es la autoridad del texto hablado. `tts_deferred` evita
                    // que audio generado con el texto sin limpiar llegue al
                    // cliente antes de la sanitización central.
                    if (orchestrated.tts && !orchestrated.tts_deferred) {
                        responseAudio = extractTtsBuffer(orchestrated.tts);
                        logger.log('[PIPELINE] TTS (Kokoro/Orchestrator) recibido', responseAudio?.length || 0, 'bytes');
                    }
                    // Ejecutar acciones retornadas por el orquestador
                    if (orchestrated.actions?.length) {
                        logger.log('[PIPELINE] Acciones del orquestador:', orchestrated.actions.length);
                        for (const action of orchestrated.actions) {
                            logger.log('[PIPELINE]   →', action.name, JSON.stringify(action.result || {}).slice(0, 100));
                            sendToUI({ type: 'orchestrator_action', action: action.name, result: action.result });
                        }
                    }
                    // Enviar estado de diálogo al frontend
                    if (orchestrated.current_state) {
                        sendToUI({ type: 'dialogue_state', state: orchestrated.current_state, emotion });
                    }
                    if (orchestrated.deterministic && (orchestrated.confirmed
                        || orchestrated.new_order
                        || orchestrated.state === 'completed'
                        || orchestrated.order_status === 'sent_to_kitchen')) {
                        state.voiceSessionClosed = true;
                        allowCurrentTurnResponse = orchestrated.confirmed === true
                            && orchestrated.close_reason === 'order_confirmed';
                    }
                } else if (!llmResult) {
                    // ── Fallback: LLM directo (Node.js) — con streaming + TTS por chunks en paralelo ──
                    logger.log('[PIPELINE] Orchestrator no disponible, usando LLM directo (streaming paralelo)');
                    const streamChunks = [];
                    const ttsPromises = [];
                    let chunkSeq = 0;
                    llmResult = await llmOrchestrator.processTextStream(asrText, (sentence, isFinal) => {
                        const segmentIndex = chunkSeq++;
                        logger.log(`[STREAM] chunk #${segmentIndex + 1}: "${sentence.slice(0, 60)}" (final=${isFinal})`);
                        if (sentence.length > 3) {
                            // Lanzar TTS en paralelo — NO esperar (así el stream sigue generando)
                            const ttsPromise = (async () => {
                                try {
                                    const prepared = speechPlayback.prepare(sentence, {
                                        source: 'llm_stream',
                                        sessionId: state.sessionId,
                                        mesa: state.mesa || null,
                                    });
                                    const cleanSentence = prepared.speechText;
                                    if (!cleanSentence) return;
                                    const ttsResp = await fetch('http://127.0.0.1:3500/speak', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ text: cleanSentence }),
                                    });
                                    if (ttsResp.ok) {
                                        const ttsData = await ttsResp.json();
                                        if (ttsData.wav_base64) {
                                            const audioBuf = wavToPcm16Mono16k(Buffer.from(ttsData.wav_base64, 'base64'));
                                            streamChunks[segmentIndex] = audioBuf;
                                            logger.log(`[STREAM] TTS chunk #${segmentIndex + 1}: ${audioBuf.length} bytes`);
                                        }
                                    }
                                } catch (e) {
                                    logger.warn(`[STREAM TTS] Error: ${e.message}`);
                                }
                            })();
                            ttsPromises.push(ttsPromise);
                            return ttsPromise;
                        }
                    });
                    // Esperar a que todos los TTS en paralelo terminen (usar pendingCallbacks del orchestrator si existen, si no los nuestros)
                    const allCallbacks = llmResult.pendingCallbacks?.length > 0 ? llmResult.pendingCallbacks : ttsPromises;
                    await Promise.all(allCallbacks);
                    const orderedChunks = streamChunks.filter(Boolean);
                    if (orderedChunks.length > 0) {
                        responseAudio = Buffer.concat(orderedChunks);
                    }
                    logger.log('[PIPELINE] LLM stream done:', llmResult.text?.slice(0, 80), `(+${Date.now() - t1}ms, ${streamChunks.length} TTS chunks)`);
                }
            } else if (!llmResult) {
                logger.log('[PIPELINE] LLM audio fallback start');
                llmResult = await llmOrchestrator.processAudio(state.audioBuffer, 16000);
                logger.log('[PIPELINE] LLM audio fallback result:', llmResult.text?.slice(0, 80), `(+${Date.now() - t1}ms)`);
            }

            // The session can close while ASR/LLM/TTS generation is pending.
            // Re-check immediately before any response or audio reaches the client.
            if (rejectLateResponse({ allowCurrentTurn: allowCurrentTurnResponse })) return null;

            let preparedResponse = null;
            if (llmResult?.text) {
                preparedResponse = speechPlayback.prepare(llmResult.text, {
                    source: 'voice_turn',
                    sessionId: state.sessionId,
                    mesa: state.mesa || null,
                });
                // Exponer el intervalo real de respuesta para el Overview. El
                // estado por cliente sigue en PROCESSING hasta terminar el turno;
                // solo el snapshot agregado cambia a RESPONDING para no capturar
                // TTS como una nueva entrada de voz.
                audioLabState.conversationState = 'RESPONDING';
                emitAudioLabMetrics();
                audioLabState.lastResponseText = preparedResponse.displayText;
                pushAudioLabEvent('llm_response', {
                    text: preparedResponse.displayText.slice(0, 160),
                    display_text: preparedResponse.displayText.slice(0, 160),
                    speech_text: preparedResponse.speechText.slice(0, 160),
                    clientId: state.clientId || null,
                });
            }

            if (asrText) {
                sendToUI({ type: 'asr_text', text: asrText, clientId: state.clientId });
                emitAudioLabMetrics();
            }
            if (llmResult?.text) {
                sendToUI({
                    type: 'chipi_response',
                    text: preparedResponse.displayText,
                    clientId: state.clientId,
                    session_id: state.sessionId,
                    mesa: state.mesa || null,
                    ...speechPayload(preparedResponse),
                });
                emitAudioLabMetrics();
            }

            // 3. TTS (solo si el orquestador NO devolvió audio)
            // ── TurnManager: respect turn-taking before TTS playback ─────
            if (!turnManager.canProactiveSpeak) {
                logger.log('[PIPELINE] TurnManager blocks speech output (user speaking, TTS active, or cooldown), skipping TTS');
                // Still produce text response via UI but don't play audio
                if (llmResult?.text) {
                    sendToUI({
                        type: 'chipi_response_silent',
                        text: preparedResponse?.displayText || llmResult.text,
                        clientId: state.clientId,
                        session_id: state.sessionId,
                        ...speechPayload(preparedResponse || speechPlayback.prepare(llmResult.text, { source: 'voice_turn', sessionId: state.sessionId })),
                    });
                }
                return null;
            }

            const t2 = Date.now();
            if (!responseAudio && llmResult?.text && piperTTS?.disponible) {
                logger.log('[PIPELINE] TTS (Piper/fallback) start');
                const cleanText = preparedResponse?.speechText || speechPlayback.prepare(llmResult.text, {
                    source: 'voice_turn',
                    sessionId: state.sessionId,
                    mesa: state.mesa || null,
                }).speechText;
                const b64 = await piperTTS.sintetizarBase64(cleanText);
                if (b64) {
                    responseAudio = Buffer.from(b64, 'base64');
                }
                logger.log('[PIPELINE] TTS (Piper/fallback) done', `(+${Date.now() - t2}ms)`);
            } else if (llmResult?.audio) {
                responseAudio = llmResult.audio;
            }

            // Una sesión puede cerrarse mientras Piper/Kokoro sintetiza. La
            // respuesta del turno que confirmó el pedido es la única que se
            // permite terminar; cualquier otra respuesta obsoleta se descarta.
            if (rejectLateResponse({ allowCurrentTurn: allowCurrentTurnResponse })) return null;

            // 4. Send response (chunked if audio exceeds 16-bit length field)
            responseAudio = normalizeTtsAudio(responseAudio);
            const audioLen = responseAudio?.length || 0;
            let offset = 0;
            let chunkSeq = seq;
            if (audioLen > 0) {
                // ── TurnManager: mark TTS started ─────────────────────────
                turnManager.ttsStarted({
                    messageKey: 'voice_response',
                    sessionId: state.sessionId,
                });
                const playbackDurationMs = Math.round((audioLen / 2 / 16000) * 1000);
                state.mutedUntil = Date.now() + playbackDurationMs + 300;
                if (state.ttsFinishTimer) clearTimeout(state.ttsFinishTimer);
                state.ttsFinishTimer = setTimeout(() => {
                    state.ttsFinishTimer = null;
                    state.ttsPendingUntil = 0;
                    if (turnManager.snapshot.tts_session_id === state.sessionId) turnManager.ttsFinished();
                }, playbackDurationMs + 350);
            }
            while (offset < audioLen) {
                if (rejectLateResponse({ allowCurrentTurn: allowCurrentTurnResponse })) return null;
                const chunkSize = Math.min(MAX_FRAME_PAYLOAD_BYTES, audioLen - offset);
                const chunk = buildAudioFrame({
                    type: TYPE_PCM_MONO,
                    seq: chunkSeq,
                    payload: responseAudio.subarray(offset, offset + chunkSize),
                });
                if (audioWriter.isOpen()) {
                    audioWriter.send(chunk);
                    logger.log('[PIPELINE] Chunk sent:', chunkSize, 'bytes (seq', chunkSeq, ')');
                }
                offset += chunkSize;
                chunkSeq++;
            }
            if (audioLen > 0) {
                audioLabState.tts = {
                    chunks: chunkSeq - seq,
                    bytes: audioLen,
                    durationMs: Math.round((audioLen / 2 / 16000) * 1000),
                    lastSentAt: new Date().toISOString(),
                };
                pushAudioLabEvent('tts_sent', {
                    bytes: audioLen,
                    chunks: chunkSeq - seq,
                    durationMs: audioLabState.tts.durationMs,
                });
                emitAudioLabMetrics();
                logger.log('[PIPELINE] Response sent', audioLen, 'bytes in', chunkSeq - seq, 'chunk(s)', `(total ${Date.now() - t0}ms)`);
            }
        } catch (e) {
            logger.error('[PIPELINE] Error in voice turn:', e.message);
        } finally {
            // 5. Reset state
            state.audioBuffer = Buffer.alloc(0);
            state.conversationState = 'IDLE';
            state.silenceCounter = 0;
            state.lastAudioTime = Date.now();
            audioLabState.conversationState = 'IDLE';
            if (whisperASR && typeof whisperASR.resetStream === 'function') {
                whisperASR.resetStream();
            }
            emitAudioLabMetrics();
            // ── TurnManager: ensure TTS flag is reset when no playback remains ──
            if (turnManager.isTtsActive && !state.ttsFinishTimer) {
                turnManager.ttsFinished();
            }
        }
    }

    // ── WebSocket: Audio Binario ──────────────────────────────
    wss.on('connection', (ws, req) => {
        logger.log('WS Robot conectado:', req.socket.remoteAddress);
        const url = req.url || '';
        const clientIdMatch = url.match(/[?&]clientId=([^&]+)/);
        const sessionIdMatch = url.match(/[?&]sessionId=([^&]+)/);
        const mesaQueryMatch = url.match(/[?&]mesa=(M?\d{1,2})/i);
        const clientId = clientIdMatch ? decodeURIComponent(clientIdMatch[1]) : null;
        const requestedSessionId = sessionIdMatch ? decodeURIComponent(sessionIdMatch[1]) : null;
        let requestedMesa = null;
        if (mesaQueryMatch) {
            try {
                requestedMesa = normalizeMesa(mesaQueryMatch[1]);
            } catch {
                requestedMesa = null;
            }
        }
        const role = clientId ? 'browser' : 'esp32';
        const audioWriter = createWebSocketAudioWriter(ws);
        hardwareControl.registerRobotClient(ws, { role, clientId });
        if (role === 'esp32') {
            markEsp32Connected({
                remoteAddress: req.socket.remoteAddress || null,
                transportPath: '/ws/robot',
            });
        }

        const state = {
            audioBuffer: Buffer.alloc(0),
            conversationState: 'IDLE',
            silenceCounter: 0,
            lastAudioTime: Date.now(),
            lastSeq: 0,
            ultimoTextoConfirmado: null,
            bufferTemporalTranscribiendo: '',
            sessionId: requestedSessionId || null,
            mesa: requestedMesa,
            wakeWordDetected: false,
            sessionStartedAt: Date.now(),
            clientId: clientId,
            dedicatedWhisper: null,
            sttReady: false,
            mutedUntil: 0,
            ttsFinishTimer: null,
            ttsPendingUntil: 0,
            voiceSessionClosed: false,
            audioRejectionEmitted: false,
        };

        // ── HRI: dynamic state bindings for routing ─────────────────
        Object.defineProperty(state, 'isStaffMode', {
            get() { return isStaffMode; },
            configurable: true,
        });
        Object.defineProperty(state, 'robotStateSnapshot', {
            get() { return robotStateManager.snapshot; },
            configurable: true,
        });

        if (clientId) {
            logger.log(`[WS Robot] Client ID: ${clientId}`);
        }

        function rejectIncomingAudio() {
            const session = state.sessionId ? orderSessionManager.get(state.sessionId) : null;
            let rejection = null;
            if (!state.sessionId) {
                rejection = { type: 'audio_session_required', session_status: null };
            } else if (state.voiceSessionClosed || !session || isStaleSession(session)) {
                if (isStaleSession(session)) state.voiceSessionClosed = true;
                rejection = { type: 'late_audio_rejected', session_status: session?.session_status || 'missing' };
            }
            if (!rejection) return false;
            if (!state.audioRejectionEmitted) {
                state.audioRejectionEmitted = true;
                sendToUI({
                    type: rejection.type,
                    session_id: state.sessionId,
                    session_status: rejection.session_status,
                    timestamp: new Date().toISOString(),
                });
            }
            return true;
        }

        // Escuchar eventos del motor STT en tiempo real
        const onTranscription = (msg) => {
            if (rejectIncomingAudio()) return;
            if (msg.timestamp && msg.timestamp < state.sessionStartedAt) {
                return;
            }
            if (msg.confirmed) {
                state.ultimoTextoConfirmado = msg.confirmed;
            } else if (msg.buffer) {
                state.ultimoTextoConfirmado = msg.buffer;
            }
            state.bufferTemporalTranscribiendo = msg.buffer;
            audioLabState.lastAsrPartial = msg.buffer || '';
            emitAudioLabMetrics();
        };

        (async () => {
            try {
                const { WhisperASRService } = await import('./application/WhisperASR.mjs');
                const dedicatedWhisper = new WhisperASRService({ noWakeWord: true });
                await new Promise(resolve => {
                    if (dedicatedWhisper.disponible) return resolve();
                    dedicatedWhisper.once('ready', resolve);
                    setTimeout(resolve, 2000);
                });
                state.dedicatedWhisper = dedicatedWhisper;
                state.sttReady = true;
                dedicatedWhisper.on('transcription', onTranscription);
                logger.log('[WS Robot] Dedicated WhisperASR ready for client');
            } catch (error) {
                logger.error('[WS Robot] Dedicated WhisperASR init failed:', error.message);
            }
        })();

        const cleanupInterval = setInterval(() => {
            if (state.conversationState === 'LISTENING' && Date.now() - state.lastAudioTime > 30000) {
                logger.log('VAD timeout: resetting stale audio buffer');
                state.audioBuffer = Buffer.alloc(0);
                state.conversationState = 'IDLE';
                state.silenceCounter = 0;
            }
        }, 5000);

        ws.on('message', async (data, isBinary) => {
            const frame = Buffer.isBuffer(data)
                ? data
                : isBinary || data instanceof ArrayBuffer || ArrayBuffer.isView(data)
                    ? Buffer.from(data)
                    : null;

            if (frame) {
                if (rejectIncomingAudio()) return;
                const parsed = recordEsp32Frame({
                    frame,
                    logPrefix: '[WS Robot]',
                    seqForState: state,
                });
                if (parsed) {
                    const { type, payload } = parsed;
                    if (type === 0x01 || type === 0x02) {
                        if (role === 'esp32' && AUDIO_LAB_ISOLATE_ESP32_PCM) {
                            return;
                        }

                        if (state.conversationState === 'PROCESSING') {
                            // Check barge-in: user speaking during TTS playback
                            if (turnManager.isTtsActive) {
                                const bargeResult = turnManager.userStartedSpeaking({
                                    sessionId: state.sessionId,
                                });
                                if (bargeResult.bargeIn) {
                                    logger.log('[WS Robot] Barge-in detected during TTS, cancelling playback');
                                    cancelServerTts(state, 'barge_in');
                                    state.conversationState = 'LISTENING';
                                    state.audioBuffer = Buffer.alloc(0);
                                    state.silenceCounter = 0;
                                    audioLabState.conversationState = 'LISTENING';
                                    pushAudioLabEvent('barge_in_detected', {
                                        clientId: state.clientId || null,
                                    });
                                    emitAudioLabMetrics();
                                    // Continue processing — let new utterance through
                                } else {
                                    return;
                                }
                            } else {
                                return;
                            }
                        }

                        if (state.conversationState === 'IDLE') {
                            state.conversationState = 'LISTENING';
                            audioLabState.conversationState = 'LISTENING';
                            pushAudioLabEvent('vad_listening', { role, clientId: state.clientId || null });
                            emitAudioLabMetrics();
                            logger.log('[VAD] Transition IDLE → LISTENING');
                        }

                        state.audioBuffer = Buffer.concat([state.audioBuffer, payload]);
                        state.lastAudioTime = Date.now();
                        
                        // ESP32 sends stereo PCM (interleaved L,R,L,R...).
                        // WhisperLive expects mono. Convert by averaging channels.
                        if (type === 0x02) {
                            const monoLen = Math.floor(payload.length / 4); // 4 bytes per stereo sample pair
                            const mono = Buffer.alloc(monoLen * 2); // 2 bytes per mono sample
                            for (let i = 0; i < monoLen; i++) {
                                const left = payload.readInt16LE(i * 4);
                                const right = payload.readInt16LE(i * 4 + 2);
                                mono.writeInt16LE(Math.round((left + right) / 2), i * 2);
                            }
                            if (state.sttReady && state.dedicatedWhisper) {
                                state.dedicatedWhisper.enviarAudio(mono);
                            }
                        } else {
                            if (state.sttReady && state.dedicatedWhisper) {
                                state.dedicatedWhisper.enviarAudio(payload);
                            }
                        }

                        const isSilent = detectSilence(payload, 200);
                        if (isSilent) {
                            state.silenceCounter++;
                            logger.log('[VAD] Silent frame detected', state.silenceCounter);
                        } else {
                            state.silenceCounter = 0;
                        }

                        if (state.conversationState === 'LISTENING' && state.silenceCounter >= 15) {
                            state.conversationState = 'PROCESSING';
                            audioLabState.conversationState = 'PROCESSING';
                            pushAudioLabEvent('vad_processing', { reason: 'silence', clientId: state.clientId || null });
                            emitAudioLabMetrics();
                            logger.log('[VAD] Transition LISTENING → PROCESSING (silence detected)');
                            if (state.sttReady && state.dedicatedWhisper) {
                                processVoiceTurn(state, audioWriter, state.dedicatedWhisper, llmOrchestrator, piperTTS, logger, processDeterministicVoiceTurn);
                            }
                        }

                        if (state.audioBuffer.length >= 256000 && state.conversationState === 'LISTENING') {
                            state.conversationState = 'PROCESSING';
                            audioLabState.conversationState = 'PROCESSING';
                            pushAudioLabEvent('vad_processing', { reason: 'max_buffer', clientId: state.clientId || null });
                            emitAudioLabMetrics();
                            logger.log('[VAD] Transition LISTENING → PROCESSING (max buffer)');
                            if (state.sttReady && state.dedicatedWhisper) {
                                processVoiceTurn(state, audioWriter, state.dedicatedWhisper, llmOrchestrator, piperTTS, logger, processDeterministicVoiceTurn);
                            }
                        }
                    }
                }
            }
        });

        ws.on('close', (code, reason) => {
            logger.log(`WS Robot desconectado (code=${code}, reason=${reason?.toString() || 'n/a'})`);
            state.voiceSessionClosed = true;
            if (state.ttsFinishTimer) clearTimeout(state.ttsFinishTimer);
            state.ttsFinishTimer = null;
            if (turnManager.snapshot.tts_session_id === state.sessionId) turnManager.cancelTts({ reason: 'transport_closed' });
            hardwareControl.unregisterRobotClient(ws);
            if (role === 'esp32') {
                markEsp32Disconnected({
                    code,
                    reason,
                    transportPath: '/ws/robot',
                });
            }
            clearInterval(cleanupInterval);
            state.dedicatedWhisper?.removeListener('transcription', onTranscription);
        });
        ws.on('error', (err) => {
            logger.log(`WS Robot error: ${err.message}`);
        });
    });

    // ── WebSocket: Vision Frame Capture ───────────────────────
    const pendingCaptures = new Map();

    visionWss.on('connection', (ws, req) => {
        logger.log('WS Vision conectado:', req.socket.remoteAddress);

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'frame' && msg.requestId) {
                    const resolve = pendingCaptures.get(msg.requestId);
                    if (resolve) {
                        pendingCaptures.delete(msg.requestId);
                        resolve({
                            image_base64: msg.image_base64,
                            width: msg.width || 768,
                            height: msg.height || 768,
                            timestamp: Date.now(),
                            source: 'rgb-ws',
                        });
                    }
                }
            } catch (e) {
                logger.warn('[VISION WS] Invalid message:', e.message);
            }
        });

        ws.on('close', () => {
            logger.log('WS Vision desconectado');
        });

        ws.on('error', (err) => {
            logger.log(`WS Vision error: ${err.message}`);
        });
    });

    visionManager.setWsCapture = (timeoutMs = 3000) => {
        return new Promise((resolve, reject) => {
            const requestId = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const timer = setTimeout(() => {
                pendingCaptures.delete(requestId);
                reject(new Error(`Vision capture timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pendingCaptures.set(requestId, (frame) => {
                clearTimeout(timer);
                resolve(frame);
            });
            for (const client of visionWss.clients) {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({ type: 'capture', requestId }));
                }
            }
        });
    };

    return { app, server, wss, visionWss };
}
