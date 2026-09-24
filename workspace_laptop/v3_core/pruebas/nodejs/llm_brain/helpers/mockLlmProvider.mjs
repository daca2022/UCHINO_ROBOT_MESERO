/**
 * Mock de LLM Provider para tests — Extiende MockLlmProvider con control
 * granular por llamada, historial de mensajes y respuestas configurables.
 *
 * Uso:
 *   import { createTestLlmProvider } from './helpers/mockLlmProvider.mjs';
 *   const provider = createTestLlmProvider();
 *   await provider.initSession('Eres un mesero');
 *   provider.setNextResponse({ text: 'Hola', functionCalls: [] });
 *   const res = await provider.sendText('Hola');
 *   console.log(provider.getHistory());
 *
 * @module tests/helpers/mockLlmProvider
 */

import { MockLlmProvider } from '../../src/adapters/MockLlmProvider.mjs';

/**
 * Crea un MockLlmProvider con control granular por llamada.
 * Extiende MockLlmProvider agregando:
 *   - setNextResponse() para controlar la próxima respuesta
 *   - getHistory() para inspeccionar mensajes enviados
 *   - registro del system prompt en initSession
 *
 * @param {object} [defaultResponses] - Respuestas por defecto (opcional)
 * @returns {TestLlmProvider}
 */
export function createTestLlmProvider(defaultResponses = {}) {
    const base = new MockLlmProvider(defaultResponses);

    /** Cola de respuestas personalizadas (FIFO) */
    let nextResponses = [];

    /** Historial de mensajes {role, content} */
    const messageHistory = [];

    /** System prompt registrado */
    let systemPromptRecorded = '';

    // --- Sobrescribir métodos ---

    const origInitSession = base.initSession.bind(base);
    base.initSession = async function (systemPrompt) {
        systemPromptRecorded = systemPrompt || '';
        if (systemPrompt) {
            messageHistory.push({ role: 'system', content: systemPrompt });
        }
        return origInitSession(systemPrompt);
    };

    const origSendText = base.sendText.bind(base);
    base.sendText = async function (text, history = []) {
        messageHistory.push({ role: 'user', content: text });

        // Si hay una respuesta en cola, la usamos
        if (nextResponses.length > 0) {
            const next = nextResponses.shift();
            const response = {
                audio: null,
                text: next.text || '',
                functionCalls: next.functionCalls || [],
            };
            messageHistory.push({ role: 'assistant', content: response.text });
            return response;
        }

        // Sino, delegamos al mock base
        const response = await origSendText(text, history);
        messageHistory.push({ role: 'assistant', content: response.text });
        return response;
    };

    /**
     * Configura la próxima respuesta de sendText (FIFO).
     * Se pueden encolar varias llamando múltiples veces.
     *
     * @param {{text?: string, functionCalls?: Array<{name: string, args: object}>}} response
     */
    base.setNextResponse = function ({ text = '', functionCalls = [] } = {}) {
        nextResponses.push({ text, functionCalls });
        return base;
    };

    /**
     * Devuelve el historial de mensajes registrados.
     * @returns {Array<{role: string, content: string}>}
     */
    base.getHistory = function () {
        return [...messageHistory];
    };

    /**
     * Devuelve el system prompt registrado en initSession.
     * @returns {string}
     */
    base.getSystemPrompt = function () {
        return systemPromptRecorded;
    };

    /**
     * Limpia historial, cola de respuestas y callLog.
     */
    base.resetTestState = function () {
        nextResponses = [];
        messageHistory.length = 0;
        systemPromptRecorded = '';
        base.callLog = [];
        base.sessionActive = false;
    };

    return base;
}
