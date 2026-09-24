import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createAsrProcessRouter } from '../../src/routes/asrProcess.mjs';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';
import { classifyIntent, Intent } from '../../src/application/IntentClassifier.mjs';
import {
    CULINARY_OBSERVATION_ALLOWLIST,
    listCulinaryObservations,
    matchCulinaryObservation,
} from '../../src/application/Fase5Safety.mjs';

const LOMO = {
    id: '00000000-0000-0000-0000-000000000002',
    nombre: 'Lomo Saltado', precio: 28, categoria: 'platos', disponible: true,
    informacion_completa: true,
    ingredientes: ['carne', 'papa', 'arroz', 'cebolla', 'tomate'],
    alergenos: [],
    modificadores_disponibles: [], // sin modifiers culinarios configurados
};
const CEVICHE = {
    id: '00000000-0000-0000-0000-000000000001',
    nombre: 'Ceviche', precio: 22, categoria: 'platos', disponible: true,
    informacion_completa: true,
    ingredientes: ['pescado', 'cebolla', 'sal'], alergenos: ['pescado'],
    modificadores_disponibles: [
        { id: 'sin_cebolla',  nombre: 'Sin cebolla',  tipo: 'remove', ingrediente: 'cebolla' },
        { id: 'poco_sal',     nombre: 'Poca sal',     tipo: 'level',  ingrediente: 'sal', valor: 'low' },
    ],
};
const QA = {
    id: '00000000-0000-0000-0000-000000000099',
    nombre: 'QA Fase5', precio: 15, categoria: 'platos', disponible: true,
    informacion_completa: true,
    ingredientes: ['maní', 'cebolla', 'sal'], alergenos: ['maní'],
    modificadores_disponibles: [
        { id: 'sin_cebolla', nombre: 'Sin cebolla', tipo: 'remove', ingrediente: 'cebolla' },
    ],
};
const MENU = [LOMO, CEVICHE, QA];

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createHarness() {
    let menu = [...MENU];
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
    const memoryService = {
        pedidoRepo: repo,
        async crearPedido(data) { return repo.create(data); },
        async obtenerMenu() { return menu; },
    };
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
async function get(base, path) {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, data: await response.json() };
}

function classify(text, draftItems = []) {
    return classifyIntent({
        text, menu: MENU, draftItems,
        state: 'awaiting_confirmation',
        lastProduct: draftItems.at(-1)?.nombre || null,
    });
}

// ─── 1. Allowlist canónica ──────────────────────────────────────

test('matchCulinaryObservation detecta cada entrada de la allowlist', () => {
    const samples = [
        ['Lomo saltado sin sal',         'sin_sal'],
        ['Con poca sal por favor',       'poca_sal'],
        ['Quiero poco sal',              'poca_sal'],
        ['Lomo con poco picante',        'poco_picante'],
        ['Bien cocido por favor',        'bien_cocido'],
        ['Quiero que esté bien cocida',  'bien_cocido'],
        ['Cocinar bien la carne',        'bien_cocido'],
        ['A término medio',              'termino_medio'],
        ['La salsa aparte',              'salsa_aparte'],
        ['Sin cubiertos',                'sin_cubiertos'],
        ['Servir caliente',              'servir_caliente'],
        ['Que esté bien caliente',       'servir_caliente'],
        ['No mezclar los sabores',       'no_mezclar'],
    ];
    for (const [text, expectedId] of samples) {
        const result = matchCulinaryObservation(text);
        assert.ok(result, `debería detectar "${text}"`);
        assert.equal(result.id, expectedId, `id incorrecto para "${text}"`);
        assert.ok(result.label, 'label requerido');
    }
});

test('matchCulinaryObservation rechaza texto libre NO allowlisted', () => {
    assert.equal(matchCulinaryObservation('decorar con perejil'), null);
    assert.equal(matchCulinaryObservation('al vapor'), null);
    assert.equal(matchCulinaryObservation('a la piedra'), null);
    assert.equal(matchCulinaryObservation('congelado'), null);
    assert.equal(matchCulinaryObservation('con romero'), null);
});

test('matchCulinaryObservation ignora frases con palabras de alergia', () => {
    assert.equal(matchCulinaryObservation('Soy alérgico a la sal'), null);
    assert.equal(matchCulinaryObservation('No puedo comer sal'), null);
    assert.equal(matchCulinaryObservation('Tengo alergia a la sal'), null);
});

test('listCulinaryObservations devuelve id+label, oculta los regex internos', () => {
    const list = listCulinaryObservations();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 8, `mínimo 8 entradas (actual: ${list.length})`);
    for (const entry of list) {
        assert.ok(entry.id && entry.label, 'cada entrada expone id+label');
        assert.equal(typeof entry.patterns, 'undefined', 'no exponer regex al frontend');
    }
});

test('CULINARY_OBSERVATION_ALLOWLIST es inmutable', () => {
    assert.equal(Object.isFrozen(CULINARY_OBSERVATION_ALLOWLIST), true);
});

// ─── 2. Clasificación de intenciones ────────────────────────────

test('"Quiero un lomo saltado sin sal" → add_item_note "Sin sal"', () => {
    const r = classify('Quiero un lomo saltado sin sal');
    assert.equal(r.intent, Intent.ADD_ITEM_NOTE);
    assert.equal(r.entities.note, 'Sin sal');
    assert.equal(r.entities.observation_id, 'sin_sal');
    assert.equal(r.entities.observation_only, true);
    assert.equal(r.entities.target.nombre, 'Lomo Saltado');
    assert.equal(r.mutates_order, true);
});

test('"Lomo saltado con poca sal" → add_item_note "Poca sal"', () => {
    const r = classify('Lomo saltado con poca sal');
    assert.equal(r.intent, Intent.ADD_ITEM_NOTE);
    assert.equal(r.entities.note, 'Poca sal');
    assert.equal(r.entities.observation_id, 'poca_sal');
});

test('"Lomo saltado bien cocido" → add_item_note "Bien cocido"', () => {
    const r = classify('Lomo saltado bien cocido');
    assert.equal(r.intent, Intent.ADD_ITEM_NOTE);
    assert.equal(r.entities.note, 'Bien cocido');
});

test('"Salsa aparte" sobre Lomo en draft → add_item_note "Salsa aparte"', () => {
    const r = classify('Salsa aparte', [{ nombre: 'Lomo Saltado', cantidad: 1 }]);
    assert.equal(r.intent, Intent.ADD_ITEM_NOTE);
    assert.equal(r.entities.note, 'Salsa aparte');
});

test('"Sin cubiertos" → add_item_note "Sin cubiertos"', () => {
    const r = classify('Sin cubiertos', [{ nombre: 'Lomo Saltado', cantidad: 1 }]);
    assert.equal(r.intent, Intent.ADD_ITEM_NOTE);
    assert.equal(r.entities.note, 'Sin cubiertos');
});

test('"Dos lomos, solo uno sin sal" → add_item_note con scope=one', () => {
    const r = classify('Dos lomos, solo uno sin sal');
    assert.equal(r.intent, Intent.ADD_ITEM_NOTE);
    assert.equal(r.entities.scope, 'one');
    assert.equal(r.entities.note, 'Sin sal');
    assert.equal(r.entities.variant_plan, 'split');
});

test('"Cambia sin sal por poca sal" → replace_item_note', () => {
    const r = classify('Cambia sin sal por poca sal', [
        { nombre: 'Lomo Saltado', cantidad: 1, observaciones: ['Sin sal'] },
    ]);
    assert.equal(r.intent, Intent.REPLACE_ITEM_NOTE);
    assert.equal(r.entities.note, 'Poca sal');
    assert.equal(r.entities.from_note_id, 'sin_sal');
    assert.equal(r.entities.observation_id, 'poca_sal');
});

test('"Quita la observación sin sal" → remove_item_note', () => {
    const r = classify('Quita la observación sin sal', [
        { nombre: 'Lomo Saltado', cantidad: 1, observaciones: ['Sin sal'] },
    ]);
    assert.equal(r.intent, Intent.REMOVE_ITEM_NOTE);
});

test('Solicitud no allowlisted ni configurada → add_item_modifier (rechazo en handler)', () => {
    const r = classify('Lomo saltado sin arroz');
    assert.equal(r.intent, Intent.ADD_ITEM_MODIFIER);
    assert.equal(r.entities.modifier.ingrediente, 'arroz');
});

test('Regresión: "sin cebolla" sobre Ceviche configurado → add_item_modifier', () => {
    const r = classify('Dame un ceviche sin cebolla');
    assert.equal(r.intent, Intent.ADD_ITEM_MODIFIER);
    assert.equal(r.entities.modifier.ingrediente, 'cebolla');
});

test('"poco sal" sobre Ceviche que SÍ tiene poco_sal → add_item_modifier', () => {
    const r = classify('Quiero el ceviche con poca sal');
    assert.equal(r.intent, Intent.ADD_ITEM_MODIFIER);
    assert.equal(r.entities.modifier.ingrediente, 'sal');
});

test('"sin sal" sobre Ceviche (NO tiene sin_sal configurado) → add_item_note', () => {
    const r = classify('Ceviche sin sal');
    assert.equal(r.intent, Intent.ADD_ITEM_NOTE);
    assert.equal(r.entities.note, 'Sin sal');
    assert.equal(r.entities.target.nombre, 'Ceviche');
});

test('Una alergia declarada NUNCA se convierte en observación', () => {
    const r = classify('Soy alérgico a la sal, quiero el lomo');
    assert.equal(r.intent, Intent.DECLARE_ALLERGY);
    assert.notEqual(r.intent, Intent.ADD_ITEM_NOTE);
});

// ─── 3. Integración HTTP con el router real ────────────────────

test('Integration: "Lomo sin sal" añade producto + observación en el draft', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = `obs-int-${Date.now()}`;
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M3', interaction_mode: 'voice' });
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: 'Quiero un lomo saltado sin sal' });
    assert.equal(r.status, 200);
    assert.equal(r.data.state, 'awaiting_confirmation');
    const lomo = (r.data.products || []).find(p => p.nombre === 'Lomo Saltado');
    assert.ok(lomo, 'lomo añadido al draft');
    assert.ok(Array.isArray(lomo.observaciones) && lomo.observaciones.includes('Sin sal'),
        `observación "Sin sal" en el item (actual: ${JSON.stringify(lomo.observaciones)})`);
    assert.equal(lomo.precio_unitario ?? lomo.precio, 28, 'precio del menú intacto');
    assert.equal(r.data.requires_special_confirmation, false, 'no dispara confirmación especial');
    assert.equal((r.data.allergy_conflicts || []).length, 0, 'no se confunde con alergia');
});

test('Integration: "dos lomos, solo uno sin sal" separa en dos líneas', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = `obs-split-${Date.now()}`;
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M3', interaction_mode: 'voice' });
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: 'Dos lomos, solo uno sin sal' });
    assert.equal(r.status, 200);
    const lomos = (r.data.products || []).filter(p => p.nombre === 'Lomo Saltado');
    assert.equal(lomos.length, 2, `dos líneas de Lomo (actual: ${lomos.length})`);
    const withNote = lomos.filter(p => p.observaciones?.includes('Sin sal'));
    const withoutNote = lomos.filter(p => !p.observaciones?.includes('Sin sal'));
    assert.equal(withNote.length, 1, 'una línea con la observación');
    assert.equal(withoutNote.length, 1, 'una línea sin la observación');
    assert.equal(r.data.requires_special_confirmation, false);
});

test('Integration: rechazo de modificador no configurado con sugerencia de mesero', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = `obs-reject-${Date.now()}`;
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M3', interaction_mode: 'voice' });
    // "sin arroz" no está en modificadores_disponibles del Lomo, ni en
    // la allowlist de observaciones. El handler debe rechazar sin mutar
    // y orientar a un mesero humano.
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: 'Lomo saltado sin arroz' });
    const lomo = (r.data.products || []).find(p => p.nombre === 'Lomo Saltado');
    assert.equal(lomo, undefined, 'lomo NO añadido cuando el modifier no es válido y la observación no está allowlisted');
    assert.ok(
        r.data.text && /mesero|preparaci[oó]n|no tengo/i.test(r.data.text),
        `mensaje orienta a mesero (actual: "${(r.data.text || '').slice(0, 120)}")`,
    );
});

test('Integration: endpoint /observation-allowlist expone la allowlist', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const r = await get(base, '/api/asr/observation-allowlist');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.data));
    assert.ok(r.data.data.find(e => e.id === 'sin_sal'), 'incluye sin_sal');
    assert.ok(r.data.data.find(e => e.id === 'poco_picante'), 'incluye poco_picante');
});

test('Integration: "Quita la observación sin sal" elimina la nota sin tocar el producto', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = `obs-remove-${Date.now()}`;
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M3', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: 'Quiero un lomo saltado sin sal' });
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: 'Quita la observación sin sal' });
    assert.equal(r.status, 200);
    const lomo = (r.data.products || []).find(p => p.nombre === 'Lomo Saltado');
    assert.ok(lomo, 'lomo sigue en el draft');
    assert.equal((lomo.observaciones || []).length, 0, 'observación eliminada');
});

test('Integration: "Cambia sin sal por poca sal" reemplaza la nota', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = `obs-replace-${Date.now()}`;
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M3', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: 'Quiero un lomo saltado sin sal' });
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: 'Cambia sin sal por poca sal' });
    assert.equal(r.status, 200);
    const lomo = (r.data.products || []).find(p => p.nombre === 'Lomo Saltado');
    assert.ok(lomo, 'lomo en el draft');
    const notes = lomo.observaciones || [];
    assert.ok(!notes.includes('Sin sal'), `"Sin sal" removido (actual: ${JSON.stringify(notes)})`);
    assert.ok(notes.includes('Poca sal'), `"Poca sal" agregado (actual: ${JSON.stringify(notes)})`);
});

test('Integration: "Soy alérgico a la sal" NO se convierte en observación', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = `obs-allergy-${Date.now()}`;
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M3', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: 'Quiero un lomo saltado' });
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: 'Soy alérgico a la sal' });
    assert.equal(r.status, 200);
    const lomo = (r.data.products || []).find(p => p.nombre === 'Lomo Saltado');
    assert.ok(lomo, 'lomo en el draft');
    assert.equal((lomo.observaciones || []).includes('Sin sal'), false,
        `"Sin sal" NO debe aparecer como observación cuando se declaró alergia (actual: ${JSON.stringify(lomo.observaciones)})`);
    assert.ok((r.data.declared_allergies || []).length > 0, 'alergia registrada');
});

test('Integration: consulta de ingredientes no muta el draft', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = `obs-query-${Date.now()}`;
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M3', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: 'Quiero un lomo saltado sin sal' });
    const before = await get(base, `/api/asr/session/${sid}`);
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M3', user_text: '¿Qué ingredientes tiene el ceviche?' });
    assert.equal(r.status, 200);
    const after = await get(base, `/api/asr/session/${sid}`);
    const findLomo = arr => (arr || []).find(p => p.nombre === 'Lomo Saltado');
    const beforeLomo = findLomo(before.data.draft_items);
    const afterLomo = findLomo(after.data.draft_items);
    assert.ok(beforeLomo && afterLomo, 'Lomo en draft antes y después');
    assert.deepEqual(beforeLomo.observaciones, afterLomo.observaciones,
        'observaciones intactas tras una consulta');
});
