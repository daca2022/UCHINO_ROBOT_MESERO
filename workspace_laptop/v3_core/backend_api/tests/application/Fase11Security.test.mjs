import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { adminAuth } from '../../src/middleware/adminAuth.mjs';
import { JWT_SECRET } from '../../src/config/adminSecurity.mjs';
import { bindCustomerOrderToSession, isAdminOrderMode } from '../../src/application/OrderRequestPolicy.mjs';
import { projectPublicKitchenOrder } from '../../src/application/TableVisitService.mjs';
import { projectUiEvent } from '../../src/application/UiEventProjection.mjs';
import { createSessionsRouter } from '../../src/routes/sessions.mjs';
import { createAsrProcessRouter } from '../../src/routes/asrProcess.mjs';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';
import { SessionLifecycleService } from '../../src/application/SessionLifecycleService.mjs';

function responseDouble() {
    return {
        statusCode: 200,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    };
}

test('Fase 11 rechaza JWT firmado sin rol admin', () => {
    const response = responseDouble();
    let called = false;
    adminAuth({ headers: { authorization: `Bearer ${jwt.sign({ user: 'viewer', role: 'viewer' }, JWT_SECRET)}` } }, response, () => { called = true; });
    assert.equal(response.statusCode, 403);
    assert.equal(called, false);
});

test('Fase 11 acepta únicamente el rol admin emitido por login', () => {
    const response = responseDouble();
    let called = false;
    adminAuth({ headers: { authorization: `Bearer ${jwt.sign({ user: 'admin', role: 'admin' }, JWT_SECRET)}` } }, response, () => { called = true; });
    assert.equal(response.statusCode, 200);
    assert.equal(called, true);
});

test('Fase 11 normaliza el modo admin antes de aplicar autorización', () => {
    for (const body of [
        { mode: 'admin' },
        { mode: 'ADMIN' },
        { mode: ' Admin ' },
        { modo: 'aDmIn' },
        { modo: ' admin ' },
    ]) assert.equal(isAdminOrderMode(body), true);
    for (const body of [{ mode: 'tablet' }, { modo: 'voice' }, {}, { mode: 'administrator' }]) {
        assert.equal(isAdminOrderMode(body), false);
    }
});

test('Fase 11 liga el pedido de cliente a la mesa y visita de la sesión', () => {
    const session = {
        session_id: 'session-bound',
        session_access_token: 'token-bound',
        session_status: 'active',
        state: 'editing_order',
        mesa: 'M8',
        visit_id: 'visit-bound',
    };
    const accepted = bindCustomerOrderToSession({ session_id: 'spoofed', mesa: 'mesa 8', visit_id: 'spoofed-visit' }, session);
    assert.equal(accepted.ok, false);
    assert.equal(accepted.code, 'SESSION_VISIT_MISMATCH');

    const bound = bindCustomerOrderToSession({ session_id: session.session_id, items: [] }, session);
    assert.equal(bound.ok, true);
    assert.equal(bound.body.session_id, session.session_id);
    assert.equal(bound.body.mesa, 'M8');
    assert.equal(bound.body.table_id, 'M8');
    assert.equal(bound.body.visit_id, session.visit_id);

    const wrongTable = bindCustomerOrderToSession({ mesa: 'M4' }, session);
    assert.equal(wrongTable.code, 'SESSION_TABLE_MISMATCH');
});

test('Fase 11 impide que el cliente salte estados operativos del pedido', () => {
    const session = {
        session_id: 'session-state-bound',
        session_access_token: 'token-state-bound',
        session_status: 'active',
        state: 'editing_order',
        mesa: 'M8',
        visit_id: 'visit-state-bound',
    };
    for (const status of ['confirmed', 'sent_to_kitchen', 'preparing', 'ready', 'delivered', 'cancelled']) {
        const result = bindCustomerOrderToSession({ status, mesa: 'M8' }, session);
        assert.equal(result.ok, false, status);
        assert.equal(result.code, 'CUSTOMER_STATUS_FORBIDDEN', status);
    }
    const draft = bindCustomerOrderToSession({ mesa: 'M8', status: 'pending_confirmation' }, session);
    assert.equal(draft.ok, true);
    assert.equal(draft.body.status, 'draft');
    assert.equal(draft.body.estado, 'provisional');
});

test('Fase 11 la proyección pública de Cocina no expone seguridad personal', () => {
    const projected = projectPublicKitchenOrder({
        id: 'public-order',
        table_id: 'M8',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        declared_allergies: ['maní'],
        dietary_restrictions: ['sin gluten'],
        allergy_conflicts: ['maní'],
        special_warning: 'Revisión de alergia para cliente',
        requires_special_confirmation: true,
    });
    for (const field of ['declared_allergies', 'dietary_restrictions', 'allergy_conflicts', 'special_warning', 'requires_special_confirmation']) {
        assert.equal(Object.hasOwn(projected, field), false, field);
    }
});

test('Fase 11 la proyección pública de WS/UI elimina visita y seguridad, Admin conserva operación', () => {
    const event = {
        type: 'pedido_actualizado',
        session_id: 'session-ui',
        visit_id: 'visit-ui',
        pedido: {
            id: 'order-ui',
            visit_id: 'visit-ui',
            items: [{ nombre: 'Ceviche', cantidad: 1 }],
            declared_allergies: ['maní'],
            dietary_restrictions: ['sin gluten'],
            allergy_conflicts: ['maní'],
            special_warning: 'Revisión privada',
            notes: 'Pedido (sesión: session-ui)',
        },
    };
    const publicEvent = projectUiEvent(event);
    assert.equal(Object.hasOwn(publicEvent, 'visit_id'), false);
    assert.equal(Object.hasOwn(publicEvent.pedido, 'visit_id'), false);
    assert.equal(Object.hasOwn(publicEvent.pedido, 'declared_allergies'), false);
    assert.match(publicEvent.pedido.notes, /redacted/u);

    const adminEvent = projectUiEvent(event, { role: 'admin' });
    assert.equal(adminEvent.pedido.visit_id, 'visit-ui');
    assert.deepEqual(adminEvent.pedido.declared_allergies, ['maní']);
    assert.equal(Object.hasOwn(adminEvent, 'session_access_token'), false);
});

test('Fase 11 la proyección pública de Audio Lab no expone telemetría ni transcriptos', () => {
    const event = {
        type: 'audio_lab_metrics',
        snapshot: {
            esp32: { connected: true, remoteAddress: '10.0.0.8' },
            telemetry: { mic_left_rms_db: -12, doa_deg: 42 },
            last_asr_final: 'mi pedido privado',
            last_response_text: 'respuesta privada',
            conversation_state: 'PROCESSING',
            tts: { chunks: 2, bytes: 120, durationMs: 300 },
            uplink: { pcmFrames: 3, pcmBytes: 480 },
            hardware: { transport: 'usb', audio_volume: 70 },
            events: [{ id: 'event-1', name: 'asr_final', detail: { text: 'dato privado' } }],
        },
    };

    const publicEvent = projectUiEvent(event);
    assert.equal(publicEvent.snapshot.esp32.connected, true);
    assert.equal(publicEvent.snapshot.conversation_state, 'PROCESSING');
    assert.deepEqual(publicEvent.snapshot.tts, { chunks: 2, bytes: 120, durationMs: 300 });
    assert.deepEqual(publicEvent.snapshot.uplink, { pcmFrames: 3, pcmBytes: 480 });
    assert.deepEqual(publicEvent.snapshot.events, []);
    for (const field of ['remoteAddress', 'telemetry', 'last_asr_final', 'last_response_text', 'hardware']) {
        assert.equal(Object.hasOwn(publicEvent.snapshot, field), false, field);
    }

    const adminEvent = projectUiEvent(event, { role: 'admin' });
    assert.equal(adminEvent.snapshot.last_asr_final, 'mi pedido privado');
    assert.equal(adminEvent.snapshot.hardware.transport, 'usb');
});

test('Fase 11 protege snapshots y cierres de sesión con el token canónico', async () => {
    const manager = new OrderSessionManager({ menu: [] });
    const lifecycle = new SessionLifecycleService({ orderSessionManager: manager, logger: { warn() {}, log() {} } });
    const app = express();
    app.use(express.json());
    app.use('/api/sessions', createSessionsRouter(lifecycle, manager));
    const server = createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const started = await fetch(`${base}/api/sessions/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ robot_id: 'qa-security', source: 'manual' }),
        });
        const session = await started.json();
        assert.equal(started.status, 201);

        const withoutToken = await fetch(`${base}/api/sessions/${session.session_id}`);
        assert.equal(withoutToken.status, 401);
        const withToken = await fetch(`${base}/api/sessions/${session.session_id}`, {
            headers: { 'x-session-token': session.session_access_token },
        });
        const snapshot = await withToken.json();
        assert.equal(withToken.status, 200);
        assert.equal(Object.hasOwn(snapshot, 'session_access_token'), false);

        const closeWithoutToken = await fetch(`${base}/api/sessions/${session.session_id}/close`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'qa' }),
        });
        assert.equal(closeWithoutToken.status, 401);
        const closeWithToken = await fetch(`${base}/api/sessions/${session.session_id}/close`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-session-token': session.session_access_token },
            body: JSON.stringify({ reason: 'qa security' }),
        });
        assert.equal(closeWithToken.status, 200);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('Fase 11 protege mutaciones ASR con el token canónico', async () => {
    const manager = new OrderSessionManager({ menu: [] });
    const lifecycle = new SessionLifecycleService({ orderSessionManager: manager, logger: { warn() {}, log() {} } });
    const memoryService = { pedidoRepo: { async findById() { return null; } }, async obtenerMenu() { return []; } };
    const app = express();
    app.use(express.json());
    app.use('/api/asr', createAsrProcessRouter(null, manager, memoryService, () => {}, null, null, null, null, lifecycle));
    const server = createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const session = lifecycle.start({ robotId: 'qa-asr-security', mesa: 'M8', source: 'browser_test' });
        const withoutToken = await fetch(`${base}/api/asr/process`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session_id: session.session_id, user_text: 'Repíteme mi pedido' }),
        });
        assert.equal(withoutToken.status, 401);
        const sessionWithoutToken = await fetch(`${base}/api/asr/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session_id: session.session_id, mesa: 'M8' }),
        });
        assert.equal(sessionWithoutToken.status, 401);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('Fase 11 rechaza una mesa inválida en ASR con 400 determinístico', async () => {
    const manager = new OrderSessionManager({ menu: [] });
    const lifecycle = new SessionLifecycleService({ orderSessionManager: manager, logger: { warn() {}, log() {} } });
    const memoryService = { pedidoRepo: { async findById() { return null; } }, async obtenerMenu() { return []; } };
    const app = express();
    app.use(express.json());
    app.use('/api/asr', createAsrProcessRouter(null, manager, memoryService, () => {}, null, null, null, null, lifecycle));
    const server = createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const session = lifecycle.start({ robotId: 'qa-invalid-table', source: 'browser_test' });
        const response = await fetch(`${base}/api/asr/process`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-session-token': session.session_access_token },
            body: JSON.stringify({ session_id: session.session_id, mesa: 'M99', user_text: 'Repíteme mi pedido' }),
        });
        const payload = await response.json();
        assert.equal(response.status, 400);
        assert.equal(payload.code, 'INVALID_TABLE');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
