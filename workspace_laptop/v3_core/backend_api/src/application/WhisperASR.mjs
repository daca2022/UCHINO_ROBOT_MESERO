import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

/**
 * Cliente WebSocket para conectarse al servidor WhisperLiveKit local.
 * Reemplaza al antiguo wrapper de whisper.cpp.
 * Hereda de EventEmitter para emitir eventos de texto a medida que el audio se transmite en vivo.
 */
export class WhisperASRService extends EventEmitter {
    constructor(opciones = {}) {
        super();
        this.host = opciones.host || '127.0.0.1';
        this.port = opciones.port || 8001;
        const noWakeWord = opciones.noWakeWord !== false;
        const url = `ws://${this.host}:${this.port}/asr${noWakeWord ? '?no_wake_word=1' : ''}`;
        this.url = url;
        this.ws = null;
        this.disponible = false;
        this.reconnectTimeout = null;
        this.conectar();
    }

    conectar() {
        if (this.ws) {
            try { this.ws.terminate(); } catch {}
        }

        console.log(`[WhisperLive] Intentando conectar a ${this.url}...`);
        this.ws = new WebSocket(this.url);

        this.ws.on('open', () => {
            console.log('[WhisperLive] 🟢 Conectado al motor STT SimulStreaming');
            this.disponible = true;
            this.emit('ready');
        });

        this.ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                let confirmedText = '';
                if (msg.lines && msg.lines.length > 0) {
                    confirmedText = msg.lines.map(l => l.text).join(' ');
                }
                const bufferText = msg.buffer_transcription || '';
                this.emit('transcription', {
                    status: msg.status,
                    confirmed: confirmedText,
                    buffer: bufferText,
                    raw: msg,
                    timestamp: Date.now(),
                });
                if (confirmedText && !bufferText) {
                    this.emit('final_sentence', confirmedText);
                }
            } catch (err) {
                console.error('[WhisperLive] Error parseando JSON de STT:', err.message);
            }
        });

        this.ws.on('error', (err) => {
            console.error('[WhisperLive] 🔴 Error WebSocket:', err.message);
        });

        this.ws.on('close', () => {
            console.log('[WhisperLive] 🔴 Desconectado. Reintentando en 3s...');
            this.disponible = false;
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = setTimeout(() => this.conectar(), 3000);
        });
    }

    /**
     * Envía bytes crudos PCM (16-bit, 16kHz, mono) al servidor STT.
     * Este es el puente perfecto para el flujo que llega del ESP32.
     * @param {Buffer} pcmBuffer
     */
    enviarAudio(pcmBuffer) {
        if (this.disponible && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(pcmBuffer);
        } else {
            // console.warn('[WhisperLive] STT no disponible, ignorando paquete de audio');
        }
    }

    async resetStream() {
        if (!this.ws) return;
        const wasOpen = this.ws.readyState === WebSocket.OPEN;
        if (wasOpen) {
            this.ws.send(JSON.stringify({ type: 'reset' }));
            await new Promise(r => setTimeout(r, 200));
        }
    }

    /**
     * (Obsoleto) Interfaz antigua para mantener compatibilidad si algún código viejo lo llama.
     */
    async transcribirAudio(audioBuffer) {
        console.warn('[WhisperLive] Advertencia: Se llamó a transcribirAudio(), pero este motor funciona en modo streaming continuo.');
        return "El modo bloque a bloque está desactivado. Usa enviarAudio().";
    }
}
