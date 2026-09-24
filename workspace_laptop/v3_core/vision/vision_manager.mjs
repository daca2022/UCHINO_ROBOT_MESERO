/**
 * VisionManager — Backend handler for on-demand vision pipeline.
 *
 * Flow: RPi5 (RGB USB camera) → HTTP capture → Backend → base64 JPEG → OpenRouter vision → response
 *
 * Provides verMesa(), verCliente(), verLugar() as function handlers
 * that LLM function calling can invoke during dialogue.
 *
 * @module @robot-mesero/vision
 */

import http from 'node:http';

const VISION_CAPTURE_URL = process.env.VISION_CAPTURE_URL || 'http://localhost:8765';
const CAPTURE_TIMEOUT_MS = 2000;
const VISION_TIMEOUT_MS = 5000;

const VISION_PROMPTS = {
    ver_mesa: 'Describe detalladamente lo que ves en esta mesa de restaurante. Enumera: platos visibles, bebidas, cubiertos, número de comensales, si está ocupada o libre. Responde en español.',
    ver_cliente: 'Describe a la persona o personas visibles en esta imagen. Enumera: número de personas, género aproximado, edad estimada, expresión facial, si están mirando al robot o no, si parecen estar esperando servicio. Responde en español.',
    ver_lugar: 'Describe el entorno que ves alrededor del robot. Enumera: tipo de lugar (cocina, comedor, pasillo, etc.), obstáculos visibles, personas presentes, mesas cercanas, cualquier elemento relevante para la navegación. Responde en español.',
};

const MOCK_FRAME_B64 = (() => {
    const w = 768, h = 768;
    const buf = Buffer.alloc(w * h * 3, 0xFF);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 3;
            if (x < 256) { buf[i] = 200; buf[i + 1] = 180; buf[i + 2] = 160; }
            else if (x < 512) { buf[i] = 160; buf[i + 1] = 200; buf[i + 2] = 180; }
            else { buf[i] = 180; buf[i + 1] = 160; buf[i + 2] = 200; }
        }
    }
    return buf.toString('base64');
})();

export class VisionManager {
    constructor({ llmOrchestrator, logger = console, captureUrl = VISION_CAPTURE_URL, mockMode = false } = {}) {
        if (!llmOrchestrator) throw new Error('VisionManager: llmOrchestrator required');
        this.llmOrchestrator = llmOrchestrator;
        this.logger = logger;
        this.captureUrl = captureUrl;
        this.mockMode = mockMode || process.env.VISION_MOCK === 'true';
        this.stats = { captures: 0, failures: 0, totalLatencyMs: 0 };
        this.wsCapture = null;
        this.setWsCapture = null;
    }

    async verMesa({ mesa }) {
        const target = mesa ? `mesa ${mesa}` : 'área de mesas';
        const frame = await this._captureFrame();
        if (!frame) return this._noFrameResult('ver_mesa');
        const result = await this.llmOrchestrator.processImage(
            frame.image_base64,
            `[${target}] ${VISION_PROMPTS.ver_mesa}`
        );
        return this._formatResult('ver_mesa', { target: mesa || 'unknown' }, result);
    }

    async verCliente({ ubicacion = 'actual' }) {
        const frame = await this._captureFrame();
        if (!frame) return this._noFrameResult('ver_cliente');
        const result = await this.llmOrchestrator.processImage(
            frame.image_base64,
            `[Ubicación: ${ubicacion}] ${VISION_PROMPTS.ver_cliente}`
        );
        return this._formatResult('ver_cliente', { ubicacion }, result);
    }

    async verLugar() {
        const frame = await this._captureFrame();
        if (!frame) return this._noFrameResult('ver_lugar');
        const result = await this.llmOrchestrator.processImage(
            frame.image_base64,
            VISION_PROMPTS.ver_lugar
        );
        return this._formatResult('ver_lugar', {}, result);
    }

    async queryVision({ prompt, frameSource = 'rgb' }) {
        const frame = frameSource === 'mock' || this.mockMode
            ? { image_base64: MOCK_FRAME_B64, width: 768, height: 768, source: 'mock' }
            : await this._captureFrame();
        if (!frame) return { success: false, error: 'Frame capture failed', description: null };
        const t0 = Date.now();
        const result = await this.llmOrchestrator.processImage(frame.image_base64, prompt);
        const latencyMs = Date.now() - t0;
        this.stats.totalLatencyMs += latencyMs;
        return {
            success: true,
            description: result.text,
            functionCalls: result.actions || [],
            latencyMs,
            frameInfo: { width: frame.width, height: frame.height, source: frame.source },
        };
    }

    getStats() {
        const avgLatency = this.stats.captures > 0
            ? Math.round(this.stats.totalLatencyMs / this.stats.captures)
            : 0;
        return { ...this.stats, avgLatencyMs: avgLatency };
    }

    _formatResult(funcName, metadata, llmResult) {
        return {
            success: true,
            function: funcName,
            metadata,
            description: llmResult.text || 'Sin descripción visual disponible.',
            functionCalls: llmResult.actions || [],
        };
    }

    _noFrameResult(funcName) {
        this.logger.warn(`[VisionManager] No frame available for ${funcName}`);
        return {
            success: false,
            function: funcName,
            error: 'Camera frame not available. Check RGB camera connection on RPi5.',
            description: 'No se pudo capturar imagen de la cámara.',
        };
    }

    async _captureFrame() {
        if (this.mockMode) {
            this.stats.captures++;
            return { image_base64: MOCK_FRAME_B64, width: 768, height: 768, source: 'mock' };
        }
        const t0 = Date.now();
        try {
            let frame;
            if (this.setWsCapture) {
                frame = await this.setWsCapture(CAPTURE_TIMEOUT_MS);
                frame.source = 'rgb-ws';
            } else {
                frame = await this._httpCapture();
            }
            const elapsed = Date.now() - t0;
            this.stats.captures++;
            this.stats.totalLatencyMs += elapsed;
            this.logger.log(`[VisionManager] Frame captured in ${elapsed}ms via ${frame.source}`);
            return frame;
        } catch (err) {
            this.stats.failures++;
            this.logger.error(`[VisionManager] Capture failed: ${err.message}`);
            return null;
        }
    }

    _httpCapture() {
        return new Promise((resolve, reject) => {
            const url = new URL('/capture', this.captureUrl);
            const req = http.get(url.href, { timeout: CAPTURE_TIMEOUT_MS }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (!result.success) {
                            reject(new Error(result.error || 'Capture service returned failure'));
                            return;
                        }
                        resolve({
                            image_base64: result.image_base64,
                            width: result.width,
                            height: result.height,
                            source: 'rgb-camera',
                            timestamp: result.timestamp,
                        });
                    } catch (e) {
                        reject(new Error(`Invalid JSON response from capture service: ${e.message}`));
                    }
                });
            });
            req.on('error', (err) => reject(new Error(`HTTP capture request failed: ${err.message}`)));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Capture request timed out'));
            });
        });
    }
}

export const VISION_FUNCTION_HANDLERS = {
    ver_mesa: 'verMesa',
    ver_cliente: 'verCliente',
    ver_lugar: 'verLugar',
};
