/**
 * Interfaz de Proveedor LLM — Contrato para cualquier modelo de lenguaje
 * Arquitectura hexagonal: los adaptadores (Qwen Cloud, Qwen Local, Mock) implementan esto.
 *
 * Proveedores activos (jul 2026):
 *  - QwenCloudAdapter: DeepSeek V4 Flash (texto), Llama 3.1 8B (fallback), Qwen3 VL 8B (vision)
 *  - QwenAdapter: Ollama Qwen3.5:9B local (fallback offline)
 *  - MockLlmProvider: dev/test sin red
 *
 * @example
 * const brain = new LlmOrchestrator(new QwenCloudAdapter({ ... }));
 */

export class ILlmProvider {
    /**
     * Inicializa la sesión de chat/conversación.
     * @returns {Promise<void>}
     */
    async initSession() {
        throw new Error('initSession() debe ser implementado');
    }

    /**
     * Envía audio PCM y recibe respuesta de audio+texto.
     * @param {Buffer} pcm16 — Audio raw PCM 16-bit
     * @param {number} sampleRate — Frecuencia de muestreo (ej. 24000)
     * @returns {Promise<{audio: Buffer, text: string, functionCalls: Array}>}
     */
    async sendAudio(pcm16, sampleRate) {
        throw new Error('sendAudio() debe ser implementado');
    }

    /**
     * Envía texto y recibe respuesta.
     * @param {string} text
     * @param {Array} history — Historial de mensajes {role, content}
     * @returns {Promise<{text: string, functionCalls: Array}>}
     */
    async sendText(text, history = []) {
        throw new Error('sendText() debe ser implementado');
    }

    /**
     * Envía imagen + texto para análisis multimodal.
     * @param {Buffer} image — Imagen (JPEG/PNG)
     * @param {string} prompt — Texto guía
     * @returns {Promise<{text: string, functionCalls: Array}>}
     */
    async sendImage(image, prompt) {
        throw new Error('sendImage() debe ser implementado');
    }

    /**
     * Cierra la sesión y libera recursos.
     * @returns {Promise<void>}
     */
    async closeSession() {
        throw new Error('closeSession() debe ser implementado');
    }

    /**
     * Devuelve información del modelo para logging/métricas.
     * @returns {{name: string, version: string, modality: string[]}}
     */
    getModelInfo() {
        throw new Error('getModelInfo() debe ser implementado');
    }
}
