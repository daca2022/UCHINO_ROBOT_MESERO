/**
 * Tests para LlmBridgeRouter — Verifica que las rutas REST del LLM Bridge
 * funcionan correctamente con un mock de LlmOrchestrator.
 *
 * @module tests/bridge/llmBridgeRouter.test
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createLlmBridgeRouter } from '../../../backend_api/src/interfaces/llmBridgeRouter.mjs';

// ── Helpers ─────────────────────────────────────────────

/**
 * Crea un mock de LlmOrchestrator con control granular.
 * @param {object} [options]
 * @param {string} [options.chatResponse] - Texto que devuelve processText
 * @param {Array} [options.functionCalls] - Function calls a devolver
 * @param {boolean} [options.throwOnProcess] - Si processText debe lanzar error
 */
function createMockOrchestrator(options = {}) {
    const {
        chatResponse = 'Hola, soy Uchino, ¿en qué puedo ayudarte?',
        functionCalls = [],
        throwOnProcess = false,
    } = options;

    return {
        processText: throwOnProcess
            ? async () => { throw new Error('LLM connection failed'); }
            : async (text) => ({
                text: chatResponse,
                audio: null,
                actions: functionCalls.map(fc => ({
                    name: fc.name,
                    args: fc.args,
                    result: fc.result ?? { ok: true },
                })),
            }),
        handlers: {
            test_action: (args) => ({ processed: args.value }),
            express_emocion: (args) => ({ emocion: 'feliz', mensaje: 'Hola!' }),
        },
        active: { getModelInfo: () => ({ name: 'qwen-flash-dashscope' }) },
        primary: { getModelInfo: () => ({ name: 'qwen-flash-dashscope' }) },
        fallback: null,
        onFallback: false,
    };
}

/**
 * Inicia un servidor Express con el router montado en un puerto aleatorio.
 * @param {object} mockOrchestrator
 * @param {object} [mockMemoryService]
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>}
 */
function startServer(mockOrchestrator, mockMemoryService) {
    return new Promise((resolve, reject) => {
        const app = express();
        app.use(express.json());
        const router = createLlmBridgeRouter(mockOrchestrator, mockMemoryService);
        app.use('/api/llm', router);

        const server = app.listen(0, () => {
            const addr = server.address();
            resolve({
                baseUrl: `http://localhost:${addr.port}`,
                close: () => new Promise(r => server.close(r)),
            });
        });
        server.on('error', reject);
    });
}

/**
 * Helper para hacer requests HTTP con fetch.
 */
function request(baseUrl, method, path, body = undefined) {
    const url = `${baseUrl}${path}`;
    const opts = { method, headers: {} };
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    return fetch(url, opts);
}

// ── Tests ───────────────────────────────────────────────

describe('LlmBridgeRouter — LLM Bridge HTTP Router', () => {
    /** @type {{baseUrl: string, close: () => Promise<void>}} */
    let server;

    afterEach(async () => {
        if (server) {
            await server.close();
            server = null;
        }
    });

    // ── GET /api/llm/health ─────────────────────────────

    it('GET /api/llm/health — returns 200 with provider statuses', async () => {
        const mock = createMockOrchestrator();
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'GET', '/api/llm/health');
        const body = await res.json();

        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(body.providers));
        assert.ok(body.providers.length >= 1);
        assert.equal(body.active, 'qwen-flash-dashscope');
        assert.equal(typeof body.uptime, 'number');
    });

    it('GET /api/llm/health — includes fallback provider when configured', async () => {
        const mock = createMockOrchestrator();
        mock.fallback = { getModelInfo: () => ({ name: 'mock-fallback' }) };
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'GET', '/api/llm/health');
        const body = await res.json();

        assert.strictEqual(res.status, 200);
        const names = body.providers.map(p => p.name);
        assert.ok(names.includes('mock-fallback'));
    });

    // ── POST /api/llm/chat ──────────────────────────────

    it('POST /api/llm/chat — valid request returns text and provider', async () => {
        const mock = createMockOrchestrator({
            chatResponse: '¡Claro! Un café pasado, al toque.',
        });
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/chat', {
            message: 'Quiero un café',
        });
        const body = await res.json();

        assert.strictEqual(res.status, 200);
        assert.equal(body.text, '¡Claro! Un café pasado, al toque.');
        assert.equal(body.provider, 'qwen-flash-dashscope');
        assert.ok(Array.isArray(body.functionCalls));
    });

    it('POST /api/llm/chat — missing message returns 400', async () => {
        const mock = createMockOrchestrator();
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/chat', {});
        const body = await res.json();

        assert.strictEqual(res.status, 400);
        assert.ok(body.error);
        assert.ok(body.error.includes('message'));
    });

    it('POST /api/llm/chat — includes function calls in response', async () => {
        const mock = createMockOrchestrator({
            chatResponse: 'Registrando pedido...',
            functionCalls: [
                { name: 'registrar_pedido', args: { mesa: 'M1', items: ['café'] } },
            ],
        });
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/chat', {
            message: 'Quiero un café en la mesa M1',
        });
        const body = await res.json();

        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(body.functionCalls));
        assert.equal(body.functionCalls.length, 1);
        assert.equal(body.functionCalls[0].name, 'registrar_pedido');
    });

    it('POST /api/llm/chat — LLM error returns 500', async () => {
        const mock = createMockOrchestrator({ throwOnProcess: true });
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/chat', {
            message: 'Hola',
        });

        assert.strictEqual(res.status, 500);
        const body = await res.json();
        assert.ok(body.error);
    });

    // ── POST /api/llm/dialogue ──────────────────────────

    it('POST /api/llm/dialogue — valid request returns state transition', async () => {
        const mock = createMockOrchestrator({
            chatResponse: '¿Qué desea ordenar el día de hoy?',
        });
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/dialogue', {
            state: 'saludando',
            input: 'Hola, ¿tienen café?',
        });
        const body = await res.json();

        assert.strictEqual(res.status, 200);
        assert.ok(body.response);
        assert.ok(body.newState);
        assert.equal(typeof body.newState, 'string');
        assert.ok(Array.isArray(body.functionCalls));
    });

    it('POST /api/llm/dialogue — invalid state returns 400', async () => {
        const mock = createMockOrchestrator();
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/dialogue', {
            input: 'Hola',
        });
        const body = await res.json();

        assert.strictEqual(res.status, 400);
        assert.ok(body.error);
        assert.ok(body.error.includes('state'));
    });

    it('POST /api/llm/dialogue — missing input returns 400', async () => {
        const mock = createMockOrchestrator();
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/dialogue', {
            state: 'saludando',
        });
        const body = await res.json();

        assert.strictEqual(res.status, 400);
        assert.ok(body.error);
        assert.ok(body.error.includes('input'));
    });

    it('POST /api/llm/dialogue — returns emotion when present', async () => {
        const mock = createMockOrchestrator({
            chatResponse: '¡Bienvenido!',
            functionCalls: [
                { name: 'expresar_emocion', args: { emocion: 'feliz', mensaje: 'Hola!' } },
            ],
        });
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/dialogue', {
            state: 'saludando',
            input: 'Hola',
        });
        const body = await res.json();

        assert.strictEqual(res.status, 200);
        assert.equal(body.emotion, 'feliz');
    });

    // ── POST /api/llm/function-call ─────────────────────

    it('POST /api/llm/function-call — valid call returns handler result', async () => {
        const mock = createMockOrchestrator();
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/function-call', {
            name: 'test_action',
            args: { value: 42 },
        });
        const body = await res.json();

        assert.strictEqual(res.status, 200);
        assert.equal(body.success, true);
        assert.equal(body.name, 'test_action');
        assert.deepEqual(body.result, { processed: 42 });
    });

    it('POST /api/llm/function-call — missing name returns 400', async () => {
        const mock = createMockOrchestrator();
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/function-call', {
            args: { value: 42 },
        });
        const body = await res.json();

        assert.strictEqual(res.status, 400);
        assert.ok(body.error);
        assert.ok(body.error.includes('name'));
    });

    it('POST /api/llm/function-call — unknown handler returns 404', async () => {
        const mock = createMockOrchestrator();
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'POST', '/api/llm/function-call', {
            name: 'nonexistent_handler',
            args: {},
        });
        const body = await res.json();

        assert.strictEqual(res.status, 404);
        assert.ok(body.error);
        assert.ok(body.error.includes('nonexistent_handler'));
    });

    // ── CORS headers ─────────────────────────────────────

    it('CORS headers present on all responses', async () => {
        const mock = createMockOrchestrator();
        server = await startServer(mock);

        const res = await request(server.baseUrl, 'GET', '/api/llm/health');

        assert.equal(res.headers.get('access-control-allow-origin'), '*');
        assert.ok(res.headers.get('access-control-allow-methods'));
    });

    it('OPTIONS request returns 200 with CORS headers', async () => {
        const mock = createMockOrchestrator();
        server = await startServer(mock);

        const res = await fetch(`${server.baseUrl}/api/llm/chat`, {
            method: 'OPTIONS',
        });

        assert.strictEqual(res.status, 200);
        assert.equal(res.headers.get('access-control-allow-origin'), '*');
    });

    // ── Rate limiter ─────────────────────────────────────

    it('Rate limit: >10 req/s returns 429', async () => {
        const mock = createMockOrchestrator();
        server = await startServer(mock);

        // Send 15 rapid concurrent requests
        const requests = Array.from({ length: 15 }, () =>
            request(server.baseUrl, 'GET', '/api/llm/health')
        );
        const responses = await Promise.all(requests);
        const statuses = responses.map(r => r.status);

        // At least some should be 429 (rate limited)
        const rateLimited = statuses.filter(s => s === 429);
        assert.ok(rateLimited.length >= 1,
            `Expected at least 1 rate-limited (429), got statuses: ${JSON.stringify(statuses)}`);
    });
});
