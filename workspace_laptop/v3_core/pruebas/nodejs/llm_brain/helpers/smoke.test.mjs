/**
 * Smoke test — Verifica que helpers, fixtures y setup funcionan correctamente.
 * Este archivo se ejecuta con `bun test`.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { createMockFetch } from './mockFetch.mjs';
import { createTestLlmProvider } from './mockLlmProvider.mjs';
import {
    SAMPLE_CAFE_CONVERSATION,
    FUNCTION_CALL_REGISTRAR_PEDIDO,
    FUNCTION_CALL_EXPRESAR_EMOCION,
    FUNCTION_CALL_GUARDAR_MEMORIA,
    ERROR_TIMEOUT,
    ERROR_RATE_LIMIT,
    ERROR_AUTH,
    SYSTEM_PROMPT_MESERO,
} from './fixtures.mjs';

// ── Fixtures ────────────────────────────────────────────

describe('fixtures.mjs', () => {
    test('SAMPLE_CAFE_CONVERSATION tiene 7 mensajes', () => {
        expect(SAMPLE_CAFE_CONVERSATION.length).toBe(7);
    });

    test('SAMPLE_CAFE_CONVERSATION tiene roles correctos', () => {
        const roles = SAMPLE_CAFE_CONVERSATION.map(m => m.role);
        expect(roles.filter(r => r === 'system').length).toBe(1);
        expect(roles.filter(r => r === 'user').length).toBe(3);
        expect(roles.filter(r => r === 'assistant').length).toBe(3);
    });

    test('FUNCTION_CALL_REGISTRAR_PEDIDO tiene items y mesa', () => {
        expect(FUNCTION_CALL_REGISTRAR_PEDIDO.name).toBe('registrar_pedido');
        expect(FUNCTION_CALL_REGISTRAR_PEDIDO.args.items.length).toBe(3);
        expect(FUNCTION_CALL_REGISTRAR_PEDIDO.args.mesa).toBe('M3');
    });

    test('FUNCTION_CALL_EXPRESAR_EMOCION tiene emocion feliz', () => {
        expect(FUNCTION_CALL_EXPRESAR_EMOCION.name).toBe('expresar_emocion');
        expect(FUNCTION_CALL_EXPRESAR_EMOCION.args.emocion).toBe('feliz');
    });

    test('FUNCTION_CALL_GUARDAR_MEMORIA tiene clave y valor', () => {
        expect(FUNCTION_CALL_GUARDAR_MEMORIA.name).toBe('guardar_memoria');
        expect(FUNCTION_CALL_GUARDAR_MEMORIA.args.clave).toContain('cliente');
    });

    test('ERROR_TIMEOUT tiene code TIMEOUT y status 408', () => {
        expect(ERROR_TIMEOUT.code).toBe('TIMEOUT');
        expect(ERROR_TIMEOUT.statusCode).toBe(408);
    });

    test('ERROR_RATE_LIMIT tiene code RATE_LIMIT y status 429', () => {
        expect(ERROR_RATE_LIMIT.code).toBe('RATE_LIMIT');
        expect(ERROR_RATE_LIMIT.statusCode).toBe(429);
    });

    test('ERROR_AUTH tiene code AUTH_ERROR y status 401', () => {
        expect(ERROR_AUTH.code).toBe('AUTH_ERROR');
        expect(ERROR_AUTH.statusCode).toBe(401);
    });
});

// ── mockFetch ────────────────────────────────────────────

describe('mockFetch.mjs', () => {
    const mf = createMockFetch();

    beforeAll(() => mf.install());
    afterEach(() => mf.reset());
    afterAll(() => mf.uninstall());

    test('mockFetch.mock y fetch devuelve respuesta', async () => {
        mf.mock('https://api.test.com/chat', {
            status: 200,
            body: JSON.stringify({ ok: true, text: 'Hola' }),
            headers: { 'content-type': 'application/json' },
        });

        const res = await fetch('https://api.test.com/chat');
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.ok).toBe(true);
    });

    test('mockFetch.calls() registra las llamadas', async () => {
        mf.mock('/api/test', { status: 200, body: 'ok' });

        await fetch('https://api.test.com/api/test', { method: 'POST', body: 'test-data' });

        const calls = mf.calls();
        expect(calls.length).toBe(1);
        expect(calls[0].url).toContain('/api/test');
        expect(calls[0].method).toBe('POST');
    });

    test('mockFetch.reset() limpia mocks y calls', async () => {
        mf.mock('/api/test', { status: 200, body: 'ok' });
        await fetch('https://api.test.com/api/test');
        expect(mf.calls().length).toBe(1);

        mf.reset();

        expect(mf.calls().length).toBe(0);
        expect(() => fetch('https://api.test.com/api/test')).toThrow(/No hay mock/);
    });

    test('mock soporta RegExp como pattern', async () => {
        mf.mock(/\/v1\/chat/, { status: 200, body: 'regex match' });

        const res = await fetch('https://api.llm.com/v1/chat/completions');
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toBe('regex match');
    });

    test('mock soporta status code 429 (rate limit)', async () => {
        mf.mock('/rate-limited', { status: 429, body: 'Too Many Requests' });

        const res = await fetch('https://api.test.com/rate-limited');
        expect(res.status).toBe(429);
    });

    test('mock soporta status code 401 (auth error)', async () => {
        mf.mock('/auth-error', { status: 401, body: 'Unauthorized' });

        const res = await fetch('https://api.test.com/auth-error');
        expect(res.status).toBe(401);
    });

    test('mock soporta delay artificial', async () => {
        mf.mock('/slow', { status: 200, body: 'slow response', delay: 50 });

        const start = Date.now();
        const res = await fetch('https://api.test.com/slow');
        const elapsed = Date.now() - start;

        expect(elapsed).toBeGreaterThanOrEqual(45);
        expect(await res.text()).toBe('slow response');
    });
});

// ── mockLlmProvider ──────────────────────────────────────

describe('mockLlmProvider.mjs', () => {
    test('createTestLlmProvider implementa sendText', async () => {
        const provider = createTestLlmProvider();
        await provider.initSession(SYSTEM_PROMPT_MESERO);
        const res = await provider.sendText('Hola');
        expect(res).toHaveProperty('text');
        expect(res).toHaveProperty('functionCalls');
        expect(Array.isArray(res.functionCalls)).toBe(true);
    });

    test('setNextResponse controla la próxima respuesta', async () => {
        const provider = createTestLlmProvider();
        await provider.initSession('Eres un mesero');

        provider.setNextResponse({ text: 'Respuesta personalizada', functionCalls: [FUNCTION_CALL_REGISTRAR_PEDIDO] });

        const res = await provider.sendText('Quiero lomo saltado');
        expect(res.text).toBe('Respuesta personalizada');
        expect(res.functionCalls.length).toBe(1);
        expect(res.functionCalls[0].name).toBe('registrar_pedido');
    });

    test('setNextResponse FIFO: se encolan múltiples respuestas', async () => {
        const provider = createTestLlmProvider();
        await provider.initSession('test');

        provider.setNextResponse({ text: 'Primera' });
        provider.setNextResponse({ text: 'Segunda' });

        const r1 = await provider.sendText('msg1');
        const r2 = await provider.sendText('msg2');

        expect(r1.text).toBe('Primera');
        expect(r2.text).toBe('Segunda');
    });

    test('getHistory registra los mensajes', async () => {
        const provider = createTestLlmProvider();
        await provider.initSession(SYSTEM_PROMPT_MESERO);

        provider.setNextResponse({ text: '¿Qué desea ordenar?' });
        await provider.sendText('Hola');

        const history = provider.getHistory();
        expect(history.length).toBe(3); // system + user + assistant
        expect(history[0].role).toBe('system');
        expect(history[1].role).toBe('user');
        expect(history[1].content).toBe('Hola');
        expect(history[2].role).toBe('assistant');
        expect(history[2].content).toBe('¿Qué desea ordenar?');
    });

    test('getSystemPrompt devuelve el system prompt', async () => {
        const provider = createTestLlmProvider();
        await provider.initSession(SYSTEM_PROMPT_MESERO);
        expect(provider.getSystemPrompt()).toBe(SYSTEM_PROMPT_MESERO);
    });

    test('resetTestState limpia historial y cola', async () => {
        const provider = createTestLlmProvider();
        await provider.initSession('test');
        provider.setNextResponse({ text: 'Hola' });
        await provider.sendText('Hola');

        provider.resetTestState();

        expect(provider.getHistory().length).toBe(0);
        expect(provider.callLog.length).toBe(0);

        // Después de reset, sendText sin cola usa la respuesta por defecto
        await provider.initSession('test');
        const res = await provider.sendText('Hola');
        expect(res.text).toBeTruthy();
    });
});
