import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createAsrProcessRouter } from '../../src/routes/asrProcess.mjs';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';

const MENU = [
    { nombre: 'Ceviche', precio: 22, categoria: 'platos', disponible: true },
    { nombre: 'Suspiro limeño', precio: 6, categoria: 'postres', disponible: true },
];

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createHarness() {
    const orders = new Map();
    const events = [];
    let failNextDraftUpdate = false;
    const repo = {
        async create(data) {
            const order = {
                ...clone(data),
                id: data.id,
                status: data.status || 'draft',
                table_id: data.table_id || data.mesa,
                mesa: data.table_id || data.mesa,
                items: clone(data.items || data.platos || []),
                platos: clone(data.items || data.platos || []),
            };
            orders.set(order.id, order);
            return clone(order);
        },
        async findById(id) {
            return orders.has(id) ? clone(orders.get(id)) : null;
        },
        async update(id, updates) {
            if (!orders.has(id)) return null;
            if (failNextDraftUpdate && updates.status === 'draft') {
                failNextDraftUpdate = false;
                throw new Error('simulated draft write failure');
            }
            const current = orders.get(id);
            const next = { ...current, ...clone(updates) };
            if (updates.items || updates.platos) {
                next.items = clone(updates.items || updates.platos);
                next.platos = clone(next.items);
            }
            if (updates.table_id || updates.mesa) {
                next.table_id = updates.table_id || updates.mesa;
                next.mesa = next.table_id;
            }
            orders.set(id, next);
            return clone(next);
        },
    };
    const memoryService = {
        pedidoRepo: repo,
        async crearPedido(data) { return repo.create(data); },
    };
    const manager = new OrderSessionManager({ menu: MENU });
    const fase3 = {
        async process({ user_text }) {
            const text = user_text.toLowerCase();
            if (text.includes('ceviche')) {
                return { functionCalls: [{ name: 'registrar_pedido', args: { platos: [{ nombre: 'Ceviche', cantidad: 1, precio: 999 }] } }] };
            }
            if (text.includes('suspiro')) {
                return { functionCalls: [{ name: 'registrar_pedido', args: { platos: [{ nombre: 'Suspiro a la limeña', cantidad: 1, precio: 999 }] } }] };
            }
            return { functionCalls: [], text: 'Te escucho.' };
        },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/asr', createAsrProcessRouter(fase3, manager, memoryService, event => events.push(event), null));
    const server = createServer(app);

    return {
        orders,
        events,
        manager,
        failNextDraftUpdate() {
            failNextDraftUpdate = true;
        },
        async start() {
            await new Promise(resolve => server.listen(0, resolve));
            return `http://127.0.0.1:${server.address().port}`;
        },
        async stop() {
            await new Promise(resolve => server.close(resolve));
        },
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

test('voz y tableta conservan un único draft, confirman una sola vez y no borran el pedido', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase1-e2e';

    const started = await post(base, '/api/asr/session', {
        session_id,
        mesa: 'M1',
        listening: true,
    });
    assert.equal(started.data.state, 'listening');

    const first = await post(base, '/api/asr/process', {
        session_id,
        client_id: 'client-1',
        mesa: 'M1',
        user_text: 'Dame un ceviche.',
    });
    assert.equal(first.status, 200);
    assert.equal(first.data.state, 'awaiting_confirmation');
    assert.deepEqual(first.data.products.map(item => item.nombre), ['Ceviche']);

    const orderId = first.data.order_id;
    const second = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M1',
        user_text: 'Agrega un suspiro a la limeña.',
    });
    assert.equal(second.data.order_id, orderId);
    assert.deepEqual(second.data.products.map(item => item.nombre), ['Ceviche', 'Suspiro limeño']);
    assert.equal(second.data.order.total, 28);

    const removed = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M1',
        user_text: 'Quita el ceviche.',
    });
    assert.deepEqual(removed.data.products.map(item => item.nombre), ['Suspiro limeño']);

    const mesa = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M1',
        user_text: 'Soy mesa 8.',
    });
    assert.equal(mesa.data.mesa, 'M8');
    assert.equal(mesa.data.order.mesa, 'M8');

    const confirmed = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M8',
        user_text: 'Sí, confirma.',
    });
    assert.equal(confirmed.data.state, 'confirmed');
    assert.equal(confirmed.data.order_status, 'sent_to_kitchen');
    assert.equal(harness.events.filter(event => event.type === 'nuevo_pedido').length, 1);

    const repeated = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M8',
        user_text: 'Correcto.',
    });
    assert.equal(repeated.data.already_confirmed, true);
    assert.equal(harness.events.filter(event => event.type === 'nuevo_pedido').length, 1);

    const completed = await post(base, '/api/asr/complete', { session_id });
    assert.equal(completed.data.state, 'completed');
    assert.equal((await harness.orders.get(orderId)).status, 'sent_to_kitchen');

    const tableAfterConfirm = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M9',
        user_text: 'Soy mesa 9.',
    });
    assert.equal(tableAfterConfirm.status, 409);
    assert.equal((await harness.orders.get(orderId)).mesa, 'M8');
});

test('un producto táctil y otro vocal llegan al mismo carrito y pedido', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase1-touch-voice';

    const touch = await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M3',
        source: 'tablet',
        items: [{ nombre: 'Ceviche', cantidad: 1, precio: 0 }],
        text: 'Agrega Ceviche',
    });
    const voice = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M3',
        user_text: 'Agrega un suspiro.',
    });

    assert.equal(touch.data.order_id, voice.data.order_id);
    assert.deepEqual(voice.data.products.map(item => item.nombre), ['Ceviche', 'Suspiro limeño']);
    assert.equal(voice.data.order.total, 28);
});

test('cambia producto y nuevo pedido por voz modifican el mismo draft de forma determinística', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase1-change-reset';

    const draft = await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M4',
        source: 'tablet',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        text: 'Agrega Ceviche',
    });
    const changed = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M4',
        user_text: 'Cambia el ceviche por suspiro limeño.',
    });

    assert.equal(draft.status, 200);
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.data.products.map(item => item.nombre), ['Suspiro limeño']);
    assert.equal(changed.data.order_id, draft.data.order_id);

    const reset = await post(base, '/api/asr/process', {
        session_id,
        mesa: 'M4',
        user_text: 'Nuevo pedido.',
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.data.new_order, true);
    assert.equal(reset.data.state, 'idle');
    assert.equal(reset.data.order_id, null);
});

test('serializa escrituras concurrentes del mismo draft y no pierde productos', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase1-concurrent-draft';

    await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M5',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        text: 'Agrega Ceviche',
    });
    const writes = await Promise.all([
        post(base, '/api/asr/draft', {
            session_id,
            mesa: 'M5',
            items: [{ nombre: 'Suspiro limeño', cantidad: 1 }],
            text: 'Agrega Suspiro',
        }),
        post(base, '/api/asr/draft', {
            session_id,
            mesa: 'M5',
            items: [{ nombre: 'Ceviche', cantidad: 1 }],
            text: 'Agrega Ceviche',
        }),
    ]);

    assert.deepEqual(writes.map(result => result.status), [200, 200]);
    const active = await fetch(`${base}/api/asr/active-order/${session_id}`);
    const activeData = await active.json();
    assert.deepEqual(activeData.products.map(item => [item.nombre, item.cantidad]), [
        ['Ceviche', 2],
        ['Suspiro limeño', 1],
    ]);
});

test('una escritura fallida restaura el draft y el reintento no duplica productos', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase1-draft-rollback';

    await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M6',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        text: 'Agrega Ceviche',
    });
    harness.failNextDraftUpdate();
    const failed = await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M6',
        items: [{ nombre: 'Suspiro limeño', cantidad: 1 }],
        text: 'Agrega Suspiro',
    });
    const retry = await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M6',
        items: [{ nombre: 'Suspiro limeño', cantidad: 1 }],
        text: 'Agrega Suspiro',
    });

    assert.equal(failed.status, 400);
    assert.deepEqual(retry.data.products.map(item => [item.nombre, item.cantidad]), [
        ['Ceviche', 1],
        ['Suspiro limeño', 1],
    ]);
});

test('confirmaciones concurrentes actualizan cocina una sola vez antes de responder', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase1-concurrent-confirm';

    await post(base, '/api/asr/draft', {
        session_id,
        mesa: 'M7',
        items: [{ nombre: 'Ceviche', cantidad: 1 }],
        text: 'Agrega Ceviche',
    });
    const confirmations = await Promise.all([
        post(base, '/api/asr/confirm', { session_id }),
        post(base, '/api/asr/confirm', { session_id }),
    ]);

    assert.deepEqual(confirmations.map(result => result.status), [200, 200]);
    assert.equal(harness.events.filter(event => event.type === 'nuevo_pedido').length, 1);
    assert.equal((await harness.orders.values().next().value).status, 'sent_to_kitchen');
});
