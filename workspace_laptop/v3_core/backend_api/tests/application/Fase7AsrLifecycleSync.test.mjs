import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createAsrProcessRouter } from '../../src/routes/asrProcess.mjs';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';
import { SessionLifecycleService } from '../../src/application/SessionLifecycleService.mjs';

const MENU = [{
    id: 'drink-1',
    nombre: 'Chicha Morada',
    precio: 4,
    categoria: 'bebida',
    disponible: true,
    informacion_completa: true,
    ingredientes: ['maíz'],
    alergenos: [],
    restricciones: {},
    modificadores_disponibles: [],
}];

function createHarness() {
    const events = [];
    const orderSessionManager = new OrderSessionManager({ menu: MENU });
    const memoryService = {
        pedidoRepo: { async findById() { return null; } },
        async obtenerMenu() { return MENU; },
    };
    const sessionLifecycle = new SessionLifecycleService({
        orderSessionManager,
        sendToUI: data => events.push({ channel: 'ws', data }),
        logger: { warn() {}, log() {} },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/asr', createAsrProcessRouter(
        null,
        orderSessionManager,
        memoryService,
        data => events.push({ channel: 'ui', data }),
        null,
        null,
        null,
        null,
        sessionLifecycle,
    ));
    const server = createServer(app);
    return {
        events,
        sessionLifecycle,
        async start() {
            await new Promise(resolve => server.listen(0, resolve));
            return `http://127.0.0.1:${server.address().port}`;
        },
        async stop() {
            await new Promise(resolve => server.close(resolve));
        },
    };
}

async function post(base, path, body, sessionToken = null) {
    const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(sessionToken ? { 'x-session-token': sessionToken } : {}) },
        body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
}

test('ASR session screen sincroniza el lifecycle a active', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());

    const session = harness.sessionLifecycle.start({ robotId: 'audit-screen', mesa: 'M8', source: 'browser_test' });
    const response = await post(base, '/api/asr/session', {
        session_id: session.session_id,
        mesa: 'M8',
        interaction_mode: 'screen',
    }, session.session_access_token);

    assert.equal(response.status, 200);
    assert.equal(response.data.interaction_mode, 'screen');
    assert.equal(harness.sessionLifecycle.snapshot(session.session_id).session_status, 'active');
    assert.ok(harness.events.some(event => event.channel === 'ws' && event.data.type === 'session_mode_selected'));
});

test('ASR rechaza proceso y cambio de mesa de una sesión cerrada', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());

    const session = harness.sessionLifecycle.start({ robotId: 'audit-closed', mesa: 'M8', source: 'browser_test' });
    harness.sessionLifecycle.close({ sessionId: session.session_id, reason: 'admin_closed' });

    const processResponse = await post(base, '/api/asr/process', {
        session_id: session.session_id,
        mesa: 'M8',
        user_text: 'Agrega Chicha Morada',
    }, session.session_access_token);
    const sessionResponse = await post(base, '/api/asr/session', {
        session_id: session.session_id,
        mesa: 'M4',
    }, session.session_access_token);

    assert.equal(processResponse.status, 410);
    assert.equal(processResponse.data.code, 'STALE_SESSION');
    assert.equal(sessionResponse.status, 410);
    assert.equal(sessionResponse.data.code, 'STALE_SESSION');
    assert.equal(harness.sessionLifecycle.snapshot(session.session_id).mesa, 'M8');
});
