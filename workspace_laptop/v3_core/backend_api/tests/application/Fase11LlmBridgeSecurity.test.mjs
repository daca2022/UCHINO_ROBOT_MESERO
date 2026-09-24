import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createLlmBridgeRouter } from '../../src/interfaces/llmBridgeRouter.mjs';
import { JWT_SECRET } from '../../src/config/adminSecurity.mjs';

async function start(handler) {
    const app = express();
    app.use(express.json());
    const server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    app.use('/api/llm', createLlmBridgeRouter({ handlers: { registrar_pedido: handler } }));
    const { port } = server.address();
    return { server, url: `http://127.0.0.1:${port}/api/llm/function-call` };
}

test('Fase 11 function-call elimina campos de control antes del handler', async () => {
    let received = null;
    const { server, url } = await start(args => { received = args; return { ok: true }; });
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-internal-token': JWT_SECRET },
            body: JSON.stringify({
                name: 'registrar_pedido',
                sessionId: 'session-fase11',
                args: { mesa: 'M8', items: [], is_test: true, data_origin: 'automated_test', archived_at: 'bad' },
            }),
        });
        assert.equal(response.status, 200);
        assert.equal(received.session_id, 'session-fase11');
        assert.equal(Object.hasOwn(received, 'is_test'), false);
        assert.equal(Object.hasOwn(received, 'data_origin'), false);
        assert.equal(Object.hasOwn(received, 'archived_at'), false);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('Fase 11 function-call exige sesión explícita para registrar_pedido', async () => {
    const { server, url } = await start(() => ({ ok: true }));
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-internal-token': JWT_SECRET },
            body: JSON.stringify({ name: 'registrar_pedido', args: { mesa: 'M8', items: [] } }),
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'ORDER_SESSION_REQUIRED');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
