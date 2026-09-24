import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createAsrProcessRouter } from '../../src/routes/asrProcess.mjs';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';
import { WaiterAssistanceService } from '../../src/application/WaiterAssistanceService.mjs';

const MENU = [
    { nombre: 'Ceviche', precio: 22, categoria: 'platos', disponible: true },
    { nombre: 'Suspiro limeño', precio: 6, categoria: 'postres', disponible: true },
    { nombre: 'Tallarines verdes', precio: 20, categoria: 'platos', disponible: true },
    { nombre: 'Lomo saltado', precio: 25, categoria: 'platos', disponible: true },
];

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createHarness() {
    let currentMenu = MENU;
    const orders = new Map();
    const events = [];
    const repo = {
        async create(data) {
            const order = {
                ...clone(data),
                id: data.id,
                status: data.status || 'draft',
                items: clone(data.items || data.platos || []),
                platos: clone(data.items || data.platos || []),
                table_id: data.table_id || data.mesa,
                mesa: data.table_id || data.mesa,
            };
            orders.set(order.id, order);
            return clone(order);
        },
        async findById(id) { return orders.has(id) ? clone(orders.get(id)) : null; },
        async update(id, updates) {
            if (!orders.has(id)) return null;
            const current = orders.get(id);
            const next = { ...current, ...clone(updates) };
            if (updates.items || updates.platos) {
                next.items = clone(updates.items || updates.platos);
                next.platos = clone(next.items);
            }
            if (updates.mesa || updates.table_id) {
                next.mesa = updates.mesa || updates.table_id;
                next.table_id = next.mesa;
            }
            orders.set(id, next);
            return clone(next);
        },
    };
    const memoryService = {
        pedidoRepo: repo,
        async crearPedido(data) { return repo.create(data); },
        async obtenerMenu() { return currentMenu; },
    };
    const manager = new OrderSessionManager({ menu: MENU, memoryService });
    const waiter = new WaiterAssistanceService({ redis: null, notify: event => events.push(event) });
    const fase3 = { async process() { return { functionCalls: [], text: 'Te escucho.' }; } };
    const app = express();
    app.use(express.json());
    app.use('/api/asr', createAsrProcessRouter(fase3, manager, memoryService, event => events.push(event), null, waiter));
    const server = createServer(app);
    return {
        orders,
        events,
        setMenu(nextMenu) { currentMenu = nextMenu; },
        async start() {
            await new Promise(resolve => server.listen(0, resolve));
            return `http://127.0.0.1:${server.address().port}`;
        },
        async stop() { await new Promise(resolve => server.close(resolve)); },
    };
}

async function post(base, path, body) {
    const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
}

test('el contrato HTTP conserva modo, carrito compartido y operaciones sin LLM', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase4-http-shared-draft';

    const started = await post(base, '/api/asr/session', { session_id, mesa: '8' });
    assert.equal(started.data.state, 'choosing_interaction_mode');
    assert.equal(started.data.mode_prompt_required, true);

    const screen = await post(base, '/api/asr/process', { session_id, mesa: 'M8', user_text: 'Por pantalla' });
    assert.equal(screen.data.interaction_mode, 'screen');
    assert.equal(screen.data.mode_prompt_required, false);

    const touch = await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M8',
        source: 'tablet',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        text: 'Agrega Ceviche',
    });
    const orderId = touch.data.order_id;
    const voice = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M8',
        source: 'browser_microphone',
        user_text: 'Agrega un suspiro a la limeña',
    });
    assert.equal(voice.data.order_id, orderId);
    assert.deepEqual(voice.data.products.map(item => [item.nombre, item.cantidad]), [
        ['Ceviche', 1],
        ['Suspiro limeño', 1],
    ]);

    const total = await post(base, '/api/asr/process', { session_id, mesa: 'M8', user_text: 'Quiero dos ceviches' });
    assert.deepEqual(total.data.products.map(item => [item.nombre, item.cantidad]), [
        ['Ceviche', 2],
        ['Suspiro limeño', 1],
    ]);
    const beforeConsult = clone(total.data.products);
    const consult = await post(base, '/api/asr/process', { session_id, mesa: 'M8', user_text: 'Repíteme mi pedido' });
    assert.deepEqual(consult.data.products, beforeConsult);

    const ambiguous = await post(base, '/api/asr/process', { session_id, mesa: 'M8', user_text: 'Quita uno' });
    assert.equal(ambiguous.data.decision.intent, 'request_clarification');
    assert.deepEqual(ambiguous.data.products, beforeConsult);
    const repeatedAmbiguous = await post(base, '/api/asr/process', { session_id, mesa: 'M8', user_text: 'Quita uno' });
    assert.equal(repeatedAmbiguous.data.decision.intent, 'request_clarification');
    assert.notEqual(repeatedAmbiguous.data.text, ambiguous.data.text);
    assert.deepEqual(repeatedAmbiguous.data.products, beforeConsult);

    const removed = await post(base, '/api/asr/process', { session_id, mesa: 'M8', user_text: 'Quita el ceviche' });
    assert.deepEqual(removed.data.products.map(item => item.nombre), ['Suspiro limeño']);
});

test('reintentar el mismo turn_id reutiliza la respuesta y no duplica el draft', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase4-http-turn-retry';

    await post(base, '/api/asr/session', { session_id, mesa: 'M6', interaction_mode: 'screen' });
    const first = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M6',
        turn_id: 'retry-1',
        user_text: 'Agrega un ceviche',
    });
    const retry = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M6',
        turn_id: 'retry-1',
        user_text: 'Agrega un ceviche',
    });
    assert.deepEqual(retry.data, first.data);
    assert.deepEqual(retry.data.products.map(item => [item.nombre, item.cantidad]), [['Ceviche', 1]]);
});

test('dos turnos concurrentes con el mismo turn_id son idempotentes', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase4-http-concurrent-turn';

    await post(base, '/api/asr/session', { session_id, mesa: 'M7', interaction_mode: 'screen' });
    const [first, second] = await Promise.all([
        post(base, '/api/asr/process', { session_id, mesa: 'M7', turn_id: 'same-turn', user_text: 'Agrega un ceviche' }),
        post(base, '/api/asr/process', { session_id, mesa: 'M7', turn_id: 'same-turn', user_text: 'Agrega un ceviche' }),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(second.data, first.data);
    assert.deepEqual(first.data.products.map(item => [item.nombre, item.cantidad]), [['Ceviche', 1]]);
});

test('confirmación natural y negativa son determinísticas, idempotentes y no borran el pedido al cerrar', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase4-http-confirmation';

    await post(base, '/api/asr/session', { session_id, mesa: 'M2', listening: true });
    const draft = await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M2',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        text: 'Agrega Ceviche',
    });
    const notYet = await post(base, '/api/asr/process', { session_id, mesa: 'M2', user_text: 'Todavía no confirmes' });
    assert.equal(notYet.data.state, 'awaiting_confirmation');
    assert.equal((await harness.orders.get(draft.data.order_id)).status, 'draft');

    const confirmed = await post(base, '/api/asr/process', { session_id, mesa: 'M2', user_text: 'Confirmo mi pedido' });
    assert.equal(confirmed.data.state, 'confirmed');
    assert.equal(confirmed.data.order_status, 'sent_to_kitchen');
    const repeated = await post(base, '/api/asr/process', { session_id, mesa: 'M2', user_text: 'Ya está' });
    assert.equal(repeated.data.already_confirmed, true);
    assert.equal(harness.events.filter(event => event.type === 'nuevo_pedido').length, 1);

    const negativeAfterConfirmation = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M2',
        user_text: 'Todavía no confirmes',
    });
    assert.equal(negativeAfterConfirmation.data.state, 'confirmed');
    assert.equal(negativeAfterConfirmation.data.order_status, 'sent_to_kitchen');
    assert.equal(harness.events.filter(event => event.type === 'nuevo_pedido').length, 1);

    const sameMode = await post(base, '/api/asr/process', { session_id, mesa: 'M2', user_text: 'Por voz' });
    assert.equal(sameMode.data.state, 'confirmed');
    const lockedAdd = await post(base, '/api/asr/process', { session_id, mesa: 'M2', user_text: 'Agrega un suspiro limeño' });
    assert.equal(lockedAdd.data.state, 'confirmed');
    assert.deepEqual((await harness.orders.get(draft.data.order_id)).items.map(item => item.nombre), ['Ceviche']);

    const completed = await post(base, '/api/asr/complete', { session_id });
    assert.equal(completed.data.state, 'completed');
    assert.equal((await harness.orders.get(draft.data.order_id)).status, 'sent_to_kitchen');
});

test('cambiar de pantalla a voz conserva el estado de confirmación y no deja el draft en listening', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase4-http-mode-switch-draft';

    await post(base, '/api/asr/session', { session_id, mesa: 'M3', interaction_mode: 'screen' });
    const draft = await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M3',
        source: 'tablet',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        text: 'Agrega Ceviche',
    });
    assert.equal(draft.data.state, 'awaiting_confirmation');

    const switched = await post(base, '/api/asr/session', {
        session_id,
        mesa: 'M3',
        interaction_mode: 'voice',
        listening: true,
    });
    assert.equal(switched.data.state, 'awaiting_confirmation');

    const confirmed = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M3',
        user_text: 'Confirmo mi pedido',
    });
    assert.equal(confirmed.data.state, 'confirmed');
    assert.equal(confirmed.data.order_id, draft.data.order_id);
});

test('una sesión nueva no hereda modo, mesa ni draft de otra sesión', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());

    await post(base, '/api/asr/session', { session_id: 'fase4-session-old', mesa: 'M9', interaction_mode: 'voice' });
    await post(base, '/api/asr/draft', {
        session_id: 'fase4-session-old',
        mesa: 'M9',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        text: 'Agrega Ceviche',
    });

    const fresh = await post(base, '/api/asr/session', { session_id: 'fase4-session-new', mesa: 'M1' });
    assert.equal(fresh.data.interaction_mode, null);
    assert.equal(fresh.data.mode_prompt_required, true);
    assert.equal(fresh.data.order_id, null);
    assert.deepEqual(fresh.data.products, []);
    assert.equal(fresh.data.mesa, 'M1');
});

test('confirmar recalcula precios y total contra el menú vigente', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase4-http-reprice';

    await post(base, '/api/asr/session', { session_id, mesa: 'M5', listening: true });
    const draft = await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M5',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        text: 'Agrega Ceviche',
    });
    harness.setMenu(MENU.map(item => item.nombre === 'Ceviche' ? { ...item, precio: 30 } : item));
    const confirmed = await post(base, '/api/asr/process', { session_id, mesa: 'M5', user_text: 'Confirmo mi pedido' });
    assert.equal(confirmed.data.state, 'confirmed');
    assert.equal(confirmed.data.order.total, 30);
    assert.equal(confirmed.data.order.items[0].precio, 30);
    assert.equal((await harness.orders.get(draft.data.order_id)).total, 30);
});

test('confirmar sin pedido no llama al LLM ni crea un draft', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase4-http-empty-confirmation';

    await post(base, '/api/asr/session', { session_id, mesa: 'M4', interaction_mode: 'screen' });
    const result = await post(base, '/api/asr/process', { session_id, mesa: 'M4', user_text: 'Confirmo mi pedido' });
    assert.equal(result.status, 200);
    assert.match(result.data.text, /no hay un pedido/i);
    assert.equal(result.data.order_id, null);
    assert.equal(harness.orders.size, 0);
});

test('solicitar mesero registra evento sin crear pedido y es reutilizable', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase4-http-waiter';

    await post(base, '/api/asr/session', { session_id, mesa: '8' });
    const first = await post(base, '/api/asr/process', { session_id, mesa: 'M8', user_text: 'Llama a un mesero' });
    const second = await post(base, '/api/asr/process', { session_id, mesa: 'M8', user_text: 'Prefiero una persona' });
    assert.equal(first.data.text, 'De acuerdo. He solicitado la atención de un mesero para esta mesa.');
    assert.equal(first.data.interaction_mode, 'human_waiter');
    assert.equal(first.data.order_id, null);
    assert.equal(second.data.waiter_request.request_id, first.data.waiter_request.request_id);
    assert.equal(harness.events.filter(event => event.event === 'waiter_assistance_requested').length, 1);
});
