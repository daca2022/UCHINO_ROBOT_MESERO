/**
 * LocalTtsPlayer.mjs — FASE 5: Cola de reproducción TTS local en laptop.
 *
 * Arquitectura:
 *   - Node.js spawns local_tts_player.py (Python, tts venv) como subproceso.
 *   - Kokoro se carga una vez y permanece en memoria en el proceso Python.
 *   - Cola de reproducción gestionada en Python (hilo separado).
 *   - Comunicación vía stdin/stdout JSON línea por línea.
 *   - Nunca envía audio al ESP32.
 *
 * Eventos emitidos (escuchados por index.mjs):
 *   - tts_started       → { id, text }
 *   - tts_generated     → { id, duration_ms }
 *   - playback_queued   → { id, queue_length }
 *   - playback_started  → { id }
 *   - playback_completed → { id, duration_ms }
 *   - playback_failed   → { id, error }
 *   - cancelled         → { id }
 *   - ready             → (subproceso listo)
 *   - error             → { message }
 */

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

const SCRIPT_PATH = new URL('../../../tts/local_tts_player.py', import.meta.url).pathname;
const VENV_PATH = new URL('../../../tts/venv/bin/python3', import.meta.url).pathname;

export class LocalTtsPlayer extends EventEmitter {
    constructor({ logger = console } = {}) {
        super();
        this.logger = logger;
        this._proc = null;
        this._ready = false;
        this._closed = false;
        this._buffer = '';
        this._shutdown = false;
        this._pendingResolve = null;
        this._speaking = false;
        this._queuedIds = new Set();
    }

    get isReady() { return this._ready; }
    get isSpeaking() { return this._speaking; }

    /**
     * Inicia el subproceso Python y espera a que esté listo.
     */
    async start(timeoutMs = 15000) {
        if (this._proc) return;

        return new Promise((resolve, reject) => {
            const pythonBin = VENV_PATH;
            this._proc = spawn(pythonBin, [SCRIPT_PATH], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env, PYTHONUNBUFFERED: '1' },
            });

            this._proc.stdout.on('data', (data) => this._onData(data));
            this._proc.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) this.logger.warn(`[LocalTTS] stderr: ${msg}`);
            });

            this._proc.on('exit', (code, signal) => {
                this._ready = false;
                this._speaking = false;
                this.logger.log(`[LocalTTS] proceso terminado (code=${code}, signal=${signal})`);
                if (!this._shutdown) {
                    this.logger.log('[LocalTTS] reiniciando en 2s...');
                    setTimeout(() => this.start().catch(e => this.logger.error('[LocalTTS] restart fail:', e.message)), 2000);
                }
            });

            this._proc.on('error', (err) => {
                this._ready = false;
                this.logger.error(`[LocalTTS] error: ${err.message}`);
                reject(err);
            });

            // Esperar evento "ready" o timeout
            const timeout = setTimeout(() => {
                this._ready = false;
                reject(new Error('TTS player timeout'));
            }, timeoutMs);

            this.once('ready', () => {
                clearTimeout(timeout);
                this._ready = true;
                resolve();
            });
        });
    }

    /**
     * Sintetiza y encola un texto para reproducción.
     * Retorna el ID del item encolado.
     */
    speak(text, { id = randomUUID(), emotion = 'feliz' } = {}) {
        if (!this._ready || this._closed) {
            this.logger.warn(`[LocalTTS] no listo, speak ignorado: "${text.slice(0, 40)}..."`);
            return null;
        }

        const cmd = { cmd: 'speak', id, text, emotion };
        this._send(cmd);
        this._queuedIds.add(id);
        this._speaking = true;
        this.emit('tts_started', { id, text });
        return id;
    }

    /**
     * Encola segmentos ya sanitizados en el orden recibido. La cola Python
     * conserva el orden, mientras este proceso mantiene el estado agregado.
     */
    speakSegments(segments, { emotion = 'feliz', sessionId = null, generation = null } = {}) {
        const values = Array.isArray(segments) ? segments.map(String).map(s => s.trim()).filter(Boolean) : [];
        const ids = [];
        values.forEach((text, segmentIndex) => {
            const id = this.speak(text, {
                emotion,
                id: randomUUID(),
                sessionId,
                generation,
                segmentIndex,
                segmentCount: values.length,
            });
            if (id) ids.push(id);
        });
        return ids;
    }

    /**
     * Cancela el audio actual y vacía la cola.
     */
    cancel() {
        this._queuedIds.clear();
        this._speaking = false;
        if (!this._ready) return;
        this._send({ cmd: 'cancel' });
    }

    /**
     * Detiene el subproceso.
     */
    async stop() {
        this._shutdown = true;
        if (this._proc && this._proc.exitCode === null) {
            this._send({ cmd: 'shutdown' });
            await new Promise(r => setTimeout(r, 500));
            this._proc.kill();
        }
        this._proc = null;
        this._ready = false;
        this._speaking = false;
        this._queuedIds.clear();
    }

    // ── Internals ──────────────────────────────────────────────

    _send(cmd) {
        if (this._proc && this._proc.stdin.writable) {
            this._proc.stdin.write(JSON.stringify(cmd) + '\n');
        }
    }

    _onData(data) {
        this._buffer += data.toString();
        const lines = this._buffer.split('\n');
        this._buffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const event = JSON.parse(trimmed);
                this._handleEvent(event);
            } catch (e) {
                this.logger.warn(`[LocalTTS] JSON parse error: ${trimmed.slice(0, 80)}`);
            }
        }
    }

    _handleEvent(event) {
        const ev = event.event || event.type;

        switch (ev) {
            case 'ready':
                this.logger.log('[LocalTTS] subproceso listo');
                this.emit('ready');
                break;

            case 'pong':
                break;

            case 'tts_started':
            case 'tts_generated':
            case 'playback_queued':
            case 'playback_started':
                this._speaking = true;
                this.emit(ev, event);
                break;

            case 'playback_completed':
                this._queuedIds.delete(event.id);
                this._speaking = this._queuedIds.size > 0;
                this.logger.log(`[LocalTTS] playback completado: ${event.id?.slice(0, 8) || '?'} (${event.duration_ms || '?'}ms)`);
                this.emit(ev, event);
                break;

            case 'playback_failed':
                this._queuedIds.delete(event.id);
                this._speaking = this._queuedIds.size > 0;
                this.logger.warn(`[LocalTTS] playback falló: ${event.id?.slice(0, 8) || '?'} — ${event.error || ''}`);
                this.emit(ev, event);
                break;

            case 'cancelled':
                this._queuedIds.clear();
                this._speaking = false;
                this.emit(ev, event);
                break;

            case 'status':
                this.logger.log(`[LocalTTS] estado: ${event.message}`);
                this.emit('status', event);
                break;

            case '_log':
                this.logger.log(`[LocalTTS-python] ${event.message}`);
                break;

            default:
                this.logger.log(`[LocalTTS] evento: ${ev}`, event.message || '');
                this.emit(ev, event);
        }
    }
}
