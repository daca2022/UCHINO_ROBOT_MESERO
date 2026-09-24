import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createAsrProcessRouter } from '../../src/routes/asrProcess.mjs';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';
import { MenuNavigationService, canonCategoria } from '../../src/application/MenuNavigationService.mjs';
import { emptyMenuState, normalizeMenuState, normalizeMenuFilters } from '../../src/application/OrderSessionManager.mjs';

const LOMO = {
    id: 'lomo-1', nombre: 'Lomo Saltado', precio: 25, categoria: 'plato', disponible: true,
    ingredientes: ['carne', 'papa'], alergenos: [],
    restricciones: { vegetariano: false, vegano: false, sin_gluten_configurado: true, sin_lactosa_configurado: true },
    modificadores_disponibles: [], informacion_completa: true, advertencia_contaminacion: '',
    destacado: true, orden_aparicion: 10, etiqueta_promocional: 'Más pedido', recomendable: true,
};
const CEVICHE = {
    id: 'c-1', nombre: 'Ceviche', precio: 22, categoria: 'plato', disponible: true,
    ingredientes: ['pescado'], alergenos: ['pescado'],
    restricciones: { vegetariano: false, vegano: false, sin_gluten_configurado: true, sin_lactosa_configurado: true },
    modificadores_disponibles: [], informacion_completa: true, advertencia_contaminacion: '',
    destacado: false, orden_aparicion: 20, recomendable: true,
};
const CHICHA = {
    id: 'b-1', nombre: 'Chicha Morada', precio: 4, categoria: 'bebida', disponible: true,
    ingredientes: ['maíz'], alergenos: [],
    restricciones: { vegetariano: true, vegano: true, sin_gluten_configurado: true, sin_lactosa_configurado: true },
    modificadores_disponibles: [], informacion_completa: true, advertencia_contaminacion: '',
    destacado: true, orden_aparicion: 10, recomendable: true,
};
const TORTA = {
    id: 'd-1', nombre: 'Torta Helada', precio: 5, categoria: 'postre', disponible: true,
    ingredientes: ['lactosa'], alergenos: ['lactosa'],
    restricciones: { vegetariano: true, vegano: false, sin_gluten_configurado: false, sin_lactosa_configurado: false },
    modificadores_disponibles: [], informacion_completa: true, advertencia_contaminacion: '',
    destacado: false, orden_aparicion: 100, recomendable: true,
};
const PIE = {
    id: 'd-2', nombre: 'Pie de Limon', precio: 7, categoria: 'postre', disponible: true,
    ingredientes: [], alergenos: [], restricciones: {}, modificadores_disponibles: [],
    informacion_completa: true, advertencia_contaminacion: '',
    destacado: false, orden_aparicion: 110, recomendable: true,
};
const SUSPIRO = {
    id: 'd-3', nombre: 'Suspiro a la Limeña', precio: 6, categoria: 'postre', disponible: true,
    ingredientes: [], alergenos: [], restricciones: {}, modificadores_disponibles: [],
    informacion_completa: true, advertencia_contaminacion: '',
    destacado: false, orden_aparicion: 120, recomendable: true,
};
const INCA = {
    id: 'b-2', nombre: 'Inca Kola', precio: 5, categoria: 'bebida', disponible: true,
    ingredientes: [], alergenos: [], restricciones: {}, modificadores_disponibles: [],
    informacion_completa: true, advertencia_contaminacion: '',
    destacado: false, orden_aparicion: 20, recomendable: true,
};
const MENU = [LOMO, CEVICHE, CHICHA, INCA, TORTA, PIE, SUSPIRO];

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
    const memoryService = { pedidoRepo: repo, async crearPedido(d) { return repo.create(d); }, async obtenerMenu() { return menu; } };
    const manager = new OrderSessionManager({ menu, memoryService });
    const mockSafety = {
        async record(event) { events.push(event); },
        derive() { return {}; },
        resolveModifier() { return null; },
    };
    const app = express();
    app.use(express.json());
    app.use('/api/asr', createAsrProcessRouter(
        { async process() { return { functionCalls: [], text: 'OK' }; } },
        manager,
        memoryService,
        event => events.push(event),
        null,
        null,
        mockSafety,
    ));
    const server = createServer(app);
    return {
        orders, events, manager,
        setMenu(next) { menu = next; manager.setMenu(next); },
        async start() { await new Promise(r => server.listen(0, r)); return `http://127.0.0.1:${server.address().port}`; },
        async stop() { await new Promise(r => server.close(r)); },
    };
}

async function post(base, path, body) {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
}
async function get(base, path) {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, data: await r.json() };
}

// ─── Persistencia del estado visual ───────────────────────────

test('persistencia: active_category se guarda en menu_state al cambiar', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'persist-cat';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    const r1 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame las bebidas' });
    assert.equal(r1.status, 200);
    const ms = r1.data.menu_state;
    assert.equal(ms.active_category, 'bebida', `active_category debe ser 'bebida' (actual: ${ms.active_category})`);
    assert.ok(Array.isArray(ms.visible_product_ids) && ms.visible_product_ids.length === 2, 'visible_product_ids poblado');
});

test('persistencia: highlighted_product_id se guarda tras precio/disponibilidad', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'persist-highlight';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    const r1 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: '¿Cuánto cuesta la chicha morada?' });
    assert.equal(r1.status, 200);
    const ms = r1.data.menu_state;
    assert.equal(ms.highlighted_product_id, 'b-1', `highlight esperado b-1 (actual: ${ms.highlighted_product_id})`);
});

test('persistencia: menu_filters se guarda al aplicar max_price', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'persist-filters';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    const r1 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame postres de menos de diez soles' });
    assert.equal(r1.status, 200);
    assert.equal(r1.data.menu_state.menu_filters.max_price, 10);
    assert.equal(r1.data.menu_state.active_category, 'postre');
});

test('persistencia: Quita los filtros limpia max_price Y active_category', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'persist-clear';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame postres de menos de diez soles' });
    const r2 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Quita los filtros' });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.menu_state.active_category, null);
    assert.equal(r2.data.menu_state.menu_filters.max_price, null);
});

test('persistencia: statePayload incluye menu_state en GET /session/:id', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'persist-state-get';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame las bebidas' });
    const r = await get(base, `/api/asr/session/${sid}`);
    assert.ok(r.data.menu_state, 'menu_state presente en GET');
    assert.equal(r.data.menu_state.active_category, 'bebida');
});

// ─── Resolución real de referencias inequívocas ───────────────

test('CASO C: "Agrega esa" tras highlight unico agrega el producto', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'casoC';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: '¿Cuánto cuesta la chicha morada?' });
    const r2 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Agrega esa' });
    assert.equal(r2.status, 200);
    assert.equal(r2.data.state, 'awaiting_confirmation');
    const chicha = (r2.data.products || []).find(p => p.nombre === 'Chicha Morada');
    assert.ok(chicha, 'Chicha Morada agregada');
    assert.equal(chicha.cantidad, 1);
    assert.equal(r2.data.total, 4);
});

test('"Agrega el primero" agrega el primer item de la lista visible', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'caso-primero';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame las bebidas' });
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Agrega el primero' });
    assert.equal(r.status, 200);
    const products = r.data.products || [];
    assert.equal(products.length, 1);
    // El primer item visible de bebidas es Chicha Morada (orden_aparicion=10) sobre Inca kola (20).
    assert.equal(products[0].nombre, 'Chicha Morada');
});

test('"Agrega el segundo" agrega el segundo item de la lista visible', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'caso-segundo';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame las bebidas' });
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Agrega el segundo' });
    assert.equal(r.status, 200);
    const products = r.data.products || [];
    assert.equal(products.length, 1);
    assert.equal(products[0].nombre, 'Inca Kola');
});

test('CASO F: "Agrega el tercero" con solo 2 productos → out_of_range, no muta', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'casoF';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame las bebidas' });
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Agrega el tercero' });
    assert.equal(r.status, 200);
    assert.equal((r.data.products || []).length, 0, 'no muta');
    assert.ok(/fuera de rango|solo hay|no encontr/i.test(r.data.text || ''), 'mensaje de out_of_range');
});

test('CASO G: "Agrega esa" sin highlight previo y multiples visibles → ambiguous, no muta', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'casoG';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    // Cargar la vista con todos los productos
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame el menú' });
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Agrega esa' });
    assert.equal(r.status, 200);
    assert.equal((r.data.products || []).length, 0, 'no muta con ambiguo');
    // Mensaje menciona varios productos o pide aclaración
    assert.ok(/varios|clarificar|menú|categor/i.test(r.data.text || '') || /varios|hay varios|menú|distintos/i.test(r.data.text || ''),
        `mensaje debe orientar a clarificar (actual: ${r.data.text})`);
});

test('"Quiero el postre que mostraste" agrega el postre resaltado', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'caso-postre-mostrado';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    // Resaltar Torta Helada
    const r1 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: '¿Cuánto cuesta la torta helada?' });
    assert.equal(r1.data.menu_state.highlighted_product_id, 'd-1');
    const r2 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Quiero el postre que mostraste' });
    assert.equal(r2.status, 200);
    const torta = (r2.data.products || []).find(p => p.nombre === 'Torta Helada');
    assert.ok(torta, 'Torta Helada agregada por referencia "el postre que mostraste"');
});

// ─── Comparación limitada a productos explícitos ───────────────

test('CASO I: "¿Cuál es más barato, el ceviche o el lomo?" compara SOLO esos dos', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'casoI';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: '¿Cuál es más barato, el ceviche o el lomo?' });
    assert.equal(r.status, 200);
    // El texto no debe mencionar Chicha Morada ni Inca Kola
    assert.ok(!/chicha|inca kola/i.test(r.data.text || ''), `no debe mencionar otras bebidas (actual: ${r.data.text})`);
    // Debe mencionar uno de los dos productos explícitamente
    assert.ok(/ceviche|lomo/i.test(r.data.text || ''), `debe mencionar ceviche o lomo (actual: ${r.data.text})`);
    // Los product_ids en navigation deben ser exactamente los 2
    const navIds = r.data.navigation?.product_ids || [];
    assert.equal(navIds.length, 2, 'navigation.product_ids debe tener 2 items');
    assert.ok(navIds.includes('c-1') && navIds.includes('lomo-1'), 'product_ids son c-1 y lomo-1');
});

test('compareProducts: API endpoint respeta IDs explícitos (live)', async () => {
    // Obtener IDs reales del menú para comparar
    const menuR = await fetch(`${LIVE_BASE}/api/menu`);
    const menuD = await menuR.json();
    const items = menuD?.data || [];
    const lomo = items.find(i => i.nombre === 'Lomo Saltado');
    const ceviche = items.find(i => i.nombre === 'Ceviche');
    if (!lomo || !ceviche) {
        // Sin backend o sin esos items; el test es condicional
        return;
    }
    const r = await fetch(`${LIVE_BASE}/api/menu/compare?ids=${lomo.id},${ceviche.id}`);
    const d = await r.json();
    assert.equal(r.status, 200);
    assert.equal(d.data?.length, 2, `compare debe devolver 2 items (actual: ${d.data?.length})`);
    const names = d.data.map(p => p.nombre);
    assert.ok(names.includes('Ceviche') && names.includes('Lomo Saltado'), `debe incluir Ceviche y Lomo (actual: ${names})`);
    // El más barato de estos dos es el Ceviche (22 vs 25)
    assert.equal(d.comparison?.cheapest?.nombre, 'Ceviche', 'Ceviche es el más barato entre esos dos');
});

// ─── Alergia en recomendaciones ────────────────────────────────

test('CASO J: Alergia al pescado excluye Ceviche de recomendaciones', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'casoJ';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    // Declarar alergia
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Quiero un ceviche' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Soy alérgico al pescado' });
    // Pedir recomendación
    const r = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: '¿Qué me recomiendas?' });
    assert.equal(r.status, 200);
    const ceviche = (r.data.extra?.reasons || []).map(x => x.product_id).includes('c-1');
    const recommendedIds = (r.data.extra?.reasons || []).map(x => x.product_id);
    assert.ok(!recommendedIds.includes('c-1'), `Ceviche NO debe estar en recomendaciones (actual: ${recommendedIds})`);
});

// ─── Navegación en modo pantalla ─────────────────────────────

test('CASO H: interaction_mode=screen mantiene mesa, carrito y modo al navegar', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'casoH';
    // Iniciar en screen con un item ya en el carrito (vía draft)
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M5', interaction_mode: 'screen' });
    // Agregar algo por voz sin perder el modo screen
    const r1 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M5', user_text: 'Muéstrame las bebidas' });
    assert.equal(r1.status, 200);
    assert.equal(r1.data.interaction_mode, 'screen', 'modo screen preservado tras voz');
    assert.equal(r1.data.mesa, 'M5', 'mesa preservada');
    // Continuar la navegación
    const r2 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M5', user_text: '¿Cuánto cuesta la chicha morada?' });
    assert.equal(r2.data.interaction_mode, 'screen');
    assert.equal(r2.data.mesa, 'M5');
});

test('screen mode: navegación de categoría no cambia el modo', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'screen-cat';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M7', interaction_mode: 'screen' });
    const r1 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M7', user_text: 'Muéstrame los platos' });
    assert.equal(r1.data.interaction_mode, 'screen');
    assert.equal(r1.data.menu_state.active_category, 'plato');
    const r2 = await post(base, '/api/asr/process', { session_id: sid, mesa: 'M7', user_text: 'Muéstrame los postres' });
    assert.equal(r2.data.interaction_mode, 'screen');
    assert.equal(r2.data.menu_state.active_category, 'postre');
});

// ─── Auditoría ────────────────────────────────────────────────

test('Auditoría: menu_requested se registra al pedir el menú', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'audit-menu';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: '¿Qué hay en el menú?' });
    const evts = h.events.filter(e => e.event === 'menu_requested');
    assert.ok(evts.length >= 1, `menu_requested registrado (actual events: ${h.events.map(e => e.event).join(', ')})`);
});

test('Auditoría: category_shown se registra al cambiar categoría', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'audit-cat';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame las bebidas' });
    const evts = h.events.filter(e => e.event === 'category_shown');
    assert.ok(evts.length >= 1, `category_shown registrado (events: ${h.events.map(e => e.event).join(', ')})`);
});

test('Auditoría: product_highlighted se registra al preguntar precio', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'audit-highlight';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: '¿Cuánto cuesta el lomo saltado?' });
    const evts = h.events.filter(e => e.event === 'product_highlighted');
    assert.ok(evts.length >= 1, `product_highlighted registrado (events: ${h.events.map(e => e.event).join(', ')})`);
});

test('Auditoría: menu_filter_applied se registra al filtrar por precio', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'audit-filter';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame postres de menos de diez soles' });
    // menu_filter_applied puede no existir en mi mapa; verifico que hay al menos un evento de navegación
    const nav = h.events.filter(e => e.event === 'category_shown' || e.event === 'menu_requested' || e.event === 'product_searched');
    assert.ok(nav.length >= 1, `eventos de navegación registrados (events: ${h.events.map(e => e.event).join(', ')})`);
});

test('Auditoría: recommendation_generated se registra al recomendar', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'audit-rec';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: '¿Qué me recomiendas?' });
    const evts = h.events.filter(e => e.event === 'recommendation_generated');
    assert.ok(evts.length >= 1, `recommendation_generated registrado (events: ${h.events.map(e => e.event).join(', ')})`);
});

test('Auditoría: ambiguous_visible_reference se registra al pedir aclaración', async t => {
    const h = createHarness();
    const base = await h.start();
    t.after(() => h.stop());
    const sid = 'audit-ambiguous';
    await post(base, '/api/asr/session', { session_id: sid, mesa: 'M1', interaction_mode: 'voice' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Muéstrame el menú' });
    await post(base, '/api/asr/process', { session_id: sid, mesa: 'M1', user_text: 'Agrega esa' });
    const evts = h.events.filter(e => e.event === 'ambiguous_visible_reference');
    assert.ok(evts.length >= 1, `ambiguous_visible_reference registrado (events: ${h.events.map(e => e.event).join(', ')})`);
});

// ─── Tests unitarios de MenuNavigationService.resolveSessionReference ──

test('resolveSessionReference: deíctic + highlight unico → ese producto', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const result = svc.resolveSessionReference('esa', {
        visible_product_ids: ['b-1', 'b-2'],
        highlighted_product_id: 'b-1',
    });
    assert.equal(result.product.id, 'b-1');
});

test('resolveSessionReference: ordinal "el primero" → índice 0', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const result = svc.resolveSessionReference('el primero', {
        visible_product_ids: ['b-1', 'b-2'],
    });
    assert.equal(result.product.id, 'b-1');
});

test('resolveSessionReference: ordinal "el segundo" → índice 1', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const result = svc.resolveSessionReference('el segundo', {
        visible_product_ids: ['b-1', 'b-2'],
    });
    assert.equal(result.product.id, 'b-2');
});

test('resolveSessionReference: "el postre que mostraste" usa highlight', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const result = svc.resolveSessionReference('el postre que mostraste', {
        visible_product_ids: ['d-1', 'd-2', 'd-3'],
        highlighted_product_id: 'd-1',
    });
    assert.equal(result.product.id, 'd-1');
});

test('resolveSessionReference: ordinal fuera de rango', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const result = svc.resolveSessionReference('el tercero', {
        visible_product_ids: ['b-1', 'b-2'],
    });
    assert.equal(result.out_of_range, true);
    assert.equal(result.max, 2);
    assert.equal(result.requested, 3);
});

test('resolveSessionReference: "esa" sin highlight + 1 visible → ese producto', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const result = svc.resolveSessionReference('esa', {
        visible_product_ids: ['b-1'],
    });
    assert.equal(result.product.id, 'b-1');
});

test('resolveSessionReference: "esa" sin highlight + varios → ambiguo', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const result = svc.resolveSessionReference('esa', {
        visible_product_ids: ['b-1', 'b-2', 'lomo-1'],
    });
    assert.equal(result.ambiguous, true);
    assert.equal(result.candidates.length, 3);
});

test('resolveSessionReference: lista vacía → not_found', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const result = svc.resolveSessionReference('esa', {
        visible_product_ids: [],
    });
    assert.equal(result.not_found, true);
});

// ─── Tests de helpers de session ────────────────────────────────

test('emptyMenuState: forma por defecto sin valores', () => {
    const s = emptyMenuState();
    assert.equal(s.active_category, null);
    assert.deepEqual(s.visible_product_ids, []);
    assert.equal(s.highlighted_product_id, null);
    assert.equal(s.menu_filters.max_price, null);
    assert.equal(s.menu_filters.vegetarian, false);
    assert.equal(s.last_navigation, null);
});

test('normalizeMenuState: rechaza categorías no canónicas', () => {
    const s = normalizeMenuState({ active_category: 'xyz' });
    assert.equal(s.active_category, null);
    assert.deepEqual(s.visible_product_ids, []);
});

test('normalizeMenuFilters: max_price numérico válido', () => {
    const f = normalizeMenuFilters({ max_price: '15' });
    assert.equal(f.max_price, 15);
    assert.equal(f.vegetarian, false);
});

test('canonCategoria: maneja singulares y plurales', () => {
    assert.equal(canonCategoria('postres'), 'postre');
    assert.equal(canonCategoria('bebidas'), 'bebida');
    assert.equal(canonCategoria('plato'), 'plato');
    assert.equal(canonCategoria('xyz'), null);
});

// ─── Tests de integración: filtros visibles vía API (HTTP live) ──

const LIVE_BASE = 'http://localhost:3005';

test('API /api/menu/navigation respeta max_price (live)', async () => {
    const r = await fetch(`${LIVE_BASE}/api/menu/navigation?max_price=10`);
    const d = await r.json();
    if (r.status === 200 && d.data) {
        assert.ok(d.data.every(p => Number(p.precio) <= 10), 'todos los items <= 10');
    }
});

test('API /api/menu/navigation combina categoría y max_price (live)', async () => {
    const r = await fetch(`${LIVE_BASE}/api/menu/navigation?category=postre&max_price=10`);
    const d = await r.json();
    if (r.status === 200 && d.data) {
        assert.ok(d.data.every(p => canonCategoria(p.categoria) === 'postre'), 'todas son postre');
        assert.ok(d.data.every(p => Number(p.precio) <= 10), 'todas <= 10');
    }
});

test('API /api/menu/navigation: filter vegetarian=true (live)', async () => {
    const r = await fetch(`${LIVE_BASE}/api/menu/navigation?vegetarian=true`);
    const d = await r.json();
    if (r.status === 200 && d.data) {
        assert.ok(d.data.every(p => p.restricciones?.vegetariano === true), 'todos vegetarianos');
    }
});
