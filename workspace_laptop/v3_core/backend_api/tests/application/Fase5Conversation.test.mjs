import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createAsrProcessRouter } from '../../src/routes/asrProcess.mjs';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';

const CEVICHE = {
    id: '00000000-0000-0000-0000-000000000001',
    nombre: 'Ceviche', precio: 22, categoria: 'platos', disponible: true,
    informacion_completa: true,
    ingredientes: ['pescado', 'cebolla', 'sal'], alergenos: ['pescado'],
    modificadores_disponibles: [
        { id: 'sin_cebolla', nombre: 'Sin cebolla', tipo: 'remove', ingrediente: 'cebolla', precio_adicional: 0 },
        { id: 'poco_sal', nombre: 'Poca sal', tipo: 'level', ingrediente: 'sal', valor: 'low', precio_adicional: 0 },
        { id: 'poco_picante', nombre: 'Poco picante', tipo: 'level', ingrediente: 'picante', valor: 'low', precio_adicional: 0 },
        { id: 'sin_picante', nombre: 'Sin picante', tipo: 'remove', ingrediente: 'picante', precio_adicional: 0 },
    ],
};
const LOMO = {
    id: '00000000-0000-0000-0000-000000000002',
    nombre: 'Lomo saltado', precio: 25, categoria: 'platos', disponible: true,
    informacion_completa: true, ingredientes: ['carne', 'cebolla', 'sal'], alergenos: [], modificadores_disponibles: [],
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createHarness() {
    let menu = [CEVICHE, LOMO];
    const orders = new Map();
    const events = [];
    const repo = {
        async create(data) {
            const order = { ...clone(data), id: data.id, status: data.status || 'draft', items: clone(data.items || []), platos: clone(data.items || []), mesa: data.mesa, table_id: data.table_id || data.mesa };
            orders.set(order.id, order);
            return clone(order);
        },
        async findById(id) { return orders.has(id) ? clone(orders.get(id)) : null; },
        async update(id, updates) {
            if (!orders.has(id)) return null;
            const current = orders.get(id);
            const next = { ...current, ...clone(updates) };
            if (updates.items || updates.platos) next.items = clone(updates.items || updates.platos);
            next.platos = clone(next.items);
            orders.set(id, next);
            return clone(next);
        },
    };
    const memoryService = { pedidoRepo: repo, async crearPedido(data) { return repo.create(data); }, async obtenerMenu() { return menu; } };
    const manager = new OrderSessionManager({ menu, memoryService });
    const app = express();
    app.use(express.json());
    app.use('/api/asr', createAsrProcessRouter(
        { async process() { return { functionCalls: [], text: 'Te escucho.' }; } },
        manager,
        memoryService,
        event => events.push(event),
        null,
        null,
    ));
    const server = createServer(app);
    return {
        orders,
        events,
        setMenu(next) { menu = next; },
        async start() { await new Promise(resolve => server.listen(0, resolve)); return `http://127.0.0.1:${server.address().port}`; },
        async stop() { await new Promise(resolve => server.close(resolve)); },
    };
}

async function post(base, path, body) {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
}

test('modificador por voz separa unidades y mantiene el mismo draft', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase5-split-lines';
    await post(base, '/api/asr/session', { session_id, mesa: 'M8', interaction_mode: 'screen' });
    const result = await post(base, '/api/asr/process', { session_id, mesa: 'M8', user_text: 'Quiero dos ceviches, pero solo uno sin cebolla' });
    assert.equal(result.status, 200);
    assert.equal(result.data.decision.intent, 'add_item_modifier');
    assert.equal(result.data.products.length, 2);
    assert.deepEqual(result.data.products.map(item => [item.cantidad, item.modificaciones.length]), [[1, 0], [1, 1]]);
    assert.equal(result.data.total, 44);
});

test('alergia bloquea confirmación normal y permite solo el override explícito', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase5-allergy-confirm';
    await post(base, '/api/asr/session', { session_id, mesa: 'M4', interaction_mode: 'voice' });
    const draft = await post(base, '/api/asr/process', { session_id, mesa: 'M4', user_text: 'Dame un ceviche' });
    assert.equal(draft.status, 200);
    const allergy = await post(base, '/api/asr/process', { session_id, mesa: 'M4', user_text: 'Soy alérgico al pescado' });
    assert.equal(allergy.data.declared_allergies[0], 'pescado');
    assert.equal(allergy.data.allergy_conflicts.length, 1);
    const blocked = await post(base, '/api/asr/process', { session_id, mesa: 'M4', user_text: 'Sí, confirma' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'SPECIAL_CONFIRMATION_REQUIRED');
    const override = await post(base, '/api/asr/process', { session_id, mesa: 'M4', user_text: 'Confírmalo de todas formas' });
    assert.equal(override.status, 200);
    assert.equal(override.data.confirmed, true);
    assert.equal(harness.events.filter(event => event.type === 'nuevo_pedido').length, 1);
});

test('una petición riesgosa en la misma frase crea draft advertido sin confirmar', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase5-risky-same-turn';
    await post(base, '/api/asr/session', { session_id, mesa: 'M5', interaction_mode: 'voice' });
    const result = await post(base, '/api/asr/process', {
        session_id, mesa: 'M5', user_text: 'Soy alérgico al pescado, pero quiero ceviche',
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.products[0].nombre, 'Ceviche');
    assert.equal(result.data.requires_special_confirmation, true);
    assert.match(result.data.special_warning, /contaminación cruzada/i);
    const blocked = await post(base, '/api/asr/process', { session_id, mesa: 'M5', user_text: 'Sí, confirma' });
    assert.equal(blocked.status, 409);
});

test('consulta de ingredientes no cambia el draft y un modificador no configurado no muta', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase5-readonly-query';
    await post(base, '/api/asr/session', { session_id, mesa: 'M3', interaction_mode: 'screen' });
    const draft = await post(base, '/api/asr/process', { session_id, mesa: 'M3', user_text: 'Dame un ceviche' });
    const before = clone(draft.data.products);
    const query = await post(base, '/api/asr/process', { session_id, mesa: 'M3', user_text: '¿Qué contiene el ceviche?' });
    assert.equal(query.data.decision.result, 'read_only');
    assert.deepEqual(query.data.products, before);
    const unsupported = await post(base, '/api/asr/process', { session_id, mesa: 'M3', user_text: 'Ceviche sin queso' });
    assert.equal(unsupported.data.updated, false);
    assert.deepEqual(unsupported.data.products, before);
});

test('editor táctil comparte el draft y permite quitar la observación sin quitar el producto', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase5-item-safety-editor';
    await post(base, '/api/asr/session', { session_id, mesa: 'M7', interaction_mode: 'screen' });
    const draft = await post(base, '/api/asr/process', { session_id, mesa: 'M7', user_text: 'Dame dos ceviches' });
    const item_id = draft.data.products[0].item_id;

    const modifier = await post(base, '/api/asr/item-safety', {
        session_id, item_id, operation: 'add_modifier', modifier_id: 'sin_cebolla', scope: 'one',
    });
    assert.equal(modifier.status, 200);
    assert.equal(modifier.data.products.length, 2);
    assert.deepEqual(modifier.data.products.map(item => [item.cantidad, item.modificaciones.length]), [[1, 0], [1, 1]]);

    const note = await post(base, '/api/asr/item-safety', {
        session_id, item_id: modifier.data.products[0].item_id, operation: 'add_note', note: 'sin limón',
    });
    assert.equal(note.status, 200);
    assert.equal(note.data.products.some(item => item.observaciones.includes('sin limón')), true);

    const removeNote = await post(base, '/api/asr/item-safety', {
        session_id, item_id: modifier.data.products[0].item_id, operation: 'remove_note',
    });
    assert.equal(removeNote.status, 200);
    assert.equal(removeNote.data.products.every(item => !item.observaciones?.length), true);
});

test('resuelve variantes por posición y reemplaza una modificación configurada', async t => {
    const harness = createHarness();
    const base = await harness.start();
    t.after(() => harness.stop());
    const session_id = 'fase5-variant-replacement';
    await post(base, '/api/asr/session', { session_id, mesa: 'M9', interaction_mode: 'voice' });
    const draft = await post(base, '/api/asr/process', { session_id, mesa: 'M9', user_text: 'Quiero dos ceviches' });
    assert.equal(draft.data.products.length, 1);
    const variant = await post(base, '/api/asr/process', { session_id, mesa: 'M9', user_text: 'El primero normal y el segundo con poca sal' });
    assert.equal(variant.status, 200);
    assert.deepEqual(variant.data.products.map(item => [item.cantidad, item.modificaciones.map(modifier => modifier.id)]), [[1, []], [1, ['poco_sal']]]);
    const replacement = await post(base, '/api/asr/process', { session_id, mesa: 'M9', user_text: 'Cambia poca sal por sin picante' });
    assert.equal(replacement.data.products.length, 2);
    assert.deepEqual(replacement.data.products.map(item => item.modificaciones.map(modifier => modifier.id)), [[], ['sin_picante']]);

    const single = await post(base, '/api/asr/process', { session_id: 'fase5-replace-single', mesa: 'M10', user_text: 'Dame un ceviche' });
    assert.equal(single.status, 200);
    const addModifier = await post(base, '/api/asr/process', { session_id: 'fase5-replace-single', mesa: 'M10', user_text: 'Poco picante' });
    assert.equal(addModifier.data.products[0].modificaciones[0].id, 'poco_picante');
    const changed = await post(base, '/api/asr/process', { session_id: 'fase5-replace-single', mesa: 'M10', user_text: 'Cambia poco picante por sin picante' });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.data.products[0].modificaciones.map(modifier => modifier.id), ['sin_picante']);
});
