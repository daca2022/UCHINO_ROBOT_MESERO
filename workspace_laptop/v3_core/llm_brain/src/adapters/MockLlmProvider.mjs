/**
 * Mock de LLM — Para tests unitarios sin llamar a APIs externas
 * Implementa ILlmProvider con respuestas deterministas.
 */

import { ILlmProvider } from '../ports/ILlmProvider.mjs';

export class MockLlmProvider extends ILlmProvider {
    constructor(responses = {}) {
        super();
        this.responses = {
            audioResponse: {
                audio: Buffer.from('mock-audio-pcm'),
                text: 'Entendido, ¿qué deseas ordenar?',
                functionCalls: [],
            },
            textResponse: {
                audio: null,
                text: 'Claro, aquí tienes el menú.',
                functionCalls: [],
            },
            imageResponse: {
                audio: null,
                text: 'Veo la imagen. Parece una mesa ocupada.',
                functionCalls: [],
            },
            ...responses,
        };
        this.sessionActive = false;
        this.callLog = [];
    }

    async initSession() {
        this.sessionActive = true;
        this.callLog.push({ method: 'initSession' });
        return this;
    }

    async sendAudio(pcm16, sampleRate) {
        this._ensureSession();
        this.callLog.push({ method: 'sendAudio', pcm16Length: pcm16?.length, sampleRate });
        return this.responses.audioResponse;
    }

    async sendText(text, history = []) {
        this._ensureSession();
        this.callLog.push({ method: 'sendText', text, historyLength: history.length });
        return this.responses.textResponse;
    }

    async sendImage(image, prompt) {
        this._ensureSession();
        this.callLog.push({ method: 'sendImage', imageLength: image?.length, prompt });
        return this.responses.imageResponse;
    }

    async closeSession() {
        this.sessionActive = false;
        this.callLog.push({ method: 'closeSession' });
    }

    getModelInfo() {
        return { name: 'mock-llm', version: '1.0.0', modality: ['text'] };
    }

    _ensureSession() {
        if (!this.sessionActive) throw new Error('MockLlmProvider: sesión no iniciada');
    }
}
