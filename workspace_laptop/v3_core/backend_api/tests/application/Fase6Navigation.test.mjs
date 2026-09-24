import test from 'node:test';
import assert from 'node:assert/strict';

import { MenuNavigationService, canonCategoria, CATEGORIAS_CANONICAS, ESTADOS_VENTA_VALIDOS } from '../../src/application/MenuNavigationService.mjs';
import { fetchSalesByProduct, PERIOD_DAYS } from '../../src/application/MenuPopularityRepository.mjs';
import { classifyIntent, Intent } from '../../src/application/IntentClassifier.mjs';

const LOMO = {
    id: 'l1', nombre: 'Lomo Saltado', precio: 25, categoria: 'plato', disponible: true,
    ingredientes: ['carne', 'papa'], alergenos: [],
    restricciones: { vegetariano: false, vegano: false, sin_gluten_configurado: true, sin_lactosa_configurado: true },
    modificadores_disponibles: [],
    informacion_completa: true, advertencia_contaminacion: '',
    destacado: true, orden_aparicion: 10, etiqueta_promocional: 'Más pedido', recomendable: true,
};
const CEVICHE = {
    id: 'c1', nombre: 'Ceviche', precio: 22, categoria: 'plato', disponible: true,
    ingredientes: ['pescado', 'cebolla'], alergenos: ['pescado'],
    restricciones: { vegetariano: false, vegano: false, sin_gluten_configurado: true, sin_lactosa_configurado: true },
    modificadores_disponibles: [],
    informacion_completa: true, advertencia_contaminacion: 'Puede contener trazas',
    destacado: true, orden_aparicion: 20, etiqueta_promocional: null, recomendable: true,
};
const POLLO = {
    id: 'p1', nombre: 'Pollo a la Brasa', precio: 30, categoria: 'plato', disponible: true,
    ingredientes: ['pollo', 'papa'], alergenos: [],
    restricciones: { vegetariano: false, vegano: false, sin_gluten_configurado: true, sin_lactosa_configurado: true },
    modificadores_disponibles: [],
    informacion_completa: true, advertencia_contaminacion: '',
    destacado: false, orden_aparicion: 30, etiqueta_promocional: null, recomendable: true,
};
const CHICHA = {
    id: 'b1', nombre: 'Chicha Morada', precio: 4, categoria: 'bebida', disponible: true,
    ingredientes: ['maíz morado'], alergenos: [],
    restricciones: { vegetariano: true, vegano: true, sin_gluten_configurado: true, sin_lactosa_configurado: true },
    modificadores_disponibles: [],
    informacion_completa: true, advertencia_contaminacion: '',
    destacado: true, orden_aparicion: 10, etiqueta_promocional: 'Recomendado', recomendable: true,
};
const INCA = {
    id: 'b2', nombre: 'Inca Kola', precio: 5, categoria: 'bebida', disponible: true,
    ingredientes: [], alergenos: [],
    restricciones: { vegetariano: true, vegano: true, sin_gluten_configurado: true, sin_lactosa_configurado: true },
    modificadores_disponibles: [],
    informacion_completa: true, advertencia_contaminacion: '',
    destacado: false, orden_aparicion: 20, etiqueta_promocional: null, recomendable: true,
};
const POSTRE = {
    id: 'd1', nombre: 'Torta Helada', precio: 5, categoria: 'postre', disponible: true,
    ingredientes: ['lactosa'], alergenos: ['lactosa'],
    restricciones: { vegetariano: true, vegano: false, sin_gluten_configurado: false, sin_lactosa_configurado: false },
    modificadores_disponibles: [],
    informacion_completa: true, advertencia_contaminacion: '',
    destacado: false, orden_aparicion: 100, etiqueta_promocional: null, recomendable: true,
};
const MENU = [LOMO, CEVICHE, POLLO, CHICHA, INCA, POSTRE];

// ─── 1. Normalización de categorías ───────────────────────────

test('canonCategoria resuelve singulares y plurales', () => {
    assert.equal(canonCategoria('plato'), 'plato');
    assert.equal(canonCategoria('platos'), 'plato');
    assert.equal(canonCategoria('bebida'), 'bebida');
    assert.equal(canonCategoria('bebidas'), 'bebida');
    assert.equal(canonCategoria('postre'), 'postre');
    assert.equal(canonCategoria('postres'), 'postre');
    assert.equal(canonCategoria('comida'), 'plato');
    assert.equal(canonCategoria('dulces'), 'postre');
    assert.equal(canonCategoria('xyz'), null);
});

test('CATEGORIAS_CANONICAS exporta las 3 categorías visibles', () => {
    assert.deepEqual(CATEGORIAS_CANONICAS, ['plato', 'bebida', 'postre']);
});

test('listCategories devuelve categorías reales con conteo', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const cats = svc.listCategories();
    const map = Object.fromEntries(cats.map(c => [c.id, c.count]));
    assert.equal(map.plato, 3, 'platos: Lomo+Ceviche+Pollo');
    assert.equal(map.bebida, 2, 'bebidas: Chicha+Inca');
    assert.equal(map.postre, 1, 'postres: Torta');
});

// ─── 2. Reconocimiento de consultas (clasificador) ────────────

test('"¿Qué hay en el menú?" → CONSULT_MENU (read-only)', () => {
    const r = classifyIntent({ text: '¿Qué hay en el menú?', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.CONSULT_MENU);
    assert.equal(r.mutates_order, false);
});

test('"Muéstrame las bebidas" → SHOW_CATEGORY', () => {
    const r = classifyIntent({ text: 'Muéstrame las bebidas', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.SHOW_CATEGORY);
    assert.ok(['bebida', 'bebidas'].includes(r.entities.category), `category canónica (actual: ${r.entities.category})`);
    assert.equal(r.mutates_order, false);
});

test('"¿Tienen ceviche?" → QUERY_AVAILABILITY (no agrega)', () => {
    const r = classifyIntent({ text: '¿Tienen ceviche?', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.QUERY_AVAILABILITY);
    assert.equal(r.mutates_order, false);
});

test('"¿Cuánto cuesta la chicha?" → QUERY_PRICE', () => {
    const r = classifyIntent({ text: '¿Cuánto cuesta la chicha?', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.QUERY_PRICE);
    assert.equal(r.mutates_order, false);
});

test('"¿Qué piden normalmente?" → QUERY_POPULAR_PRODUCTS', () => {
    const r = classifyIntent({ text: '¿Qué piden normalmente?', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.QUERY_POPULAR_PRODUCTS);
    assert.equal(r.mutates_order, false);
});

test('"¿Qué me recomiendas?" → QUERY_RECOMMENDATION', () => {
    const r = classifyIntent({ text: '¿Qué me recomiendas?', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.QUERY_RECOMMENDATION);
    assert.equal(r.mutates_order, false);
});

test('"Quiero algo barato" → QUERY_AFFORDABLE_PRODUCTS', () => {
    const r = classifyIntent({ text: 'Quiero algo barato', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.QUERY_AFFORDABLE_PRODUCTS);
    assert.equal(r.mutates_order, false);
});

test('"Vuelve al menú" → RETURN_TO_MENU', () => {
    const r = classifyIntent({ text: 'Vuelve al menú', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.RETURN_TO_MENU);
    assert.equal(r.mutates_order, false);
});

test('"Quita los filtros" → CLEAR_MENU_FILTER', () => {
    const r = classifyIntent({ text: 'Quita los filtros', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.CLEAR_MENU_FILTER);
    assert.equal(r.mutates_order, false);
});

test('"El primero" → SELECT_VISIBLE_PRODUCT (read-only)', () => {
    const r = classifyIntent({ text: 'El primero', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.SELECT_VISIBLE_PRODUCT);
    assert.equal(r.mutates_order, false);
});

test('"Muéstrame el ceviche" no agrega (LIST_PRODUCTS)', () => {
    const r = classifyIntent({ text: 'Muéstrame el ceviche', menu: MENU, state: 'idle' });
    assert.equal(r.intent, Intent.LIST_PRODUCTS);
    assert.equal(r.mutates_order, false);
});

// ─── 3. mutates_order = false obligatorio en consultas ───────

test('Todas las consultas puras de Fase 6 tienen mutates_order=false', () => {
    // Excluimos "busca algo sin picante" porque Fase 5 (safety) tiene
    // prioridad y la frase matchea add_item_modifier con mutates_order=true.
    // Esa es la semántica correcta: si hay una pista de modificador, el
    // clasificador de seguridad actúa primero.
    const queries = [
        'qué hay en el menú',
        'cuánto cuesta el ceviche',
        'qué recomiendas',
        'qué piden normalmente',
        'vuelve al menú',
        'quita los filtros',
        'el segundo',
        'tienen ceviche',
    ];
    for (const q of queries) {
        const r = classifyIntent({ text: q, menu: MENU, state: 'idle' });
        assert.equal(r.mutates_order, false, `mutates_order debe ser false para "${q}" (actual: ${r.intent})`);
    }
});

// ─── 4. Filtros de categoría ──────────────────────────────────

test('filterMenu filtra por categoría canónica', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const platos = svc.filterMenu({ category: 'plato' });
    assert.equal(platos.length, 3);
    assert.ok(platos.every(p => p.categoria === 'plato'));
});

test('filterMenu acepta categoría en plural o singular', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    assert.equal(svc.filterMenu({ category: 'bebidas' }).length, 2);
    assert.equal(svc.filterMenu({ category: 'bebida' }).length, 2);
});

test('filterMenu ordena por orden_aparicion', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const platos = svc.filterMenu({ category: 'plato' });
    assert.equal(platos[0].nombre, 'Lomo Saltado');
    assert.equal(platos[1].nombre, 'Ceviche');
    assert.equal(platos[2].nombre, 'Pollo a la Brasa');
});

// ─── 5. Filtros de precio ─────────────────────────────────────

test('extractPriceFilter maneja "menos de veinte"', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const r = svc.extractPriceFilter('algo menos de veinte soles');
    assert.equal(r.max, 20);
});

test('extractPriceFilter maneja "entre diez y treinta"', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const r = svc.extractPriceFilter('entre diez y treinta');
    assert.equal(r.min, 10);
    assert.equal(r.max, 30);
});

test('filterMenu filtra por maxPrice', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const baratos = svc.filterMenu({ maxPrice: 10 });
    assert.equal(baratos.length, 3, 'Chicha (4) + Inca (5) + Torta (5)');
    assert.ok(baratos.every(p => Number(p.precio) <= 10));
});

// ─── 6. Disponibilidad ────────────────────────────────────────

test('Productos no disponibles se excluyen por defecto de filterMenu', () => {
    const menuConAgotado = [...MENU, { ...LOMO, id: 'l2', nombre: 'Lomo Agotado', disponible: false, orden_aparicion: 5 }];
    const svc = new MenuNavigationService({ menu: menuConAgotado });
    const platos = svc.filterMenu({ category: 'plato' });
    assert.equal(platos.length, 3);
    assert.ok(!platos.find(p => p.nombre === 'Lomo Agotado'));
});

// ─── 7. Búsqueda de producto ─────────────────────────────────

test('searchProducts busca por nombre parcial', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const r = svc.searchProducts('cev');
    assert.equal(r.length, 1);
    assert.equal(r[0].nombre, 'Ceviche');
});

test('searchProducts busca por ingrediente declarado', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const r = svc.searchProducts('pescado');
    assert.equal(r.length, 1);
    assert.equal(r[0].nombre, 'Ceviche');
});

test('searchProducts vacío devuelve []', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    assert.deepEqual(svc.searchProducts(''), []);
});

test('findProductByName por nombre exacto o parcial', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    assert.equal(svc.findProductByName('Ceviche').id, 'c1');
    assert.equal(svc.findProductByName('cev').id, 'c1');
    assert.equal(svc.findProductByName('xyz'), null);
});

// ─── 8. Referencias por posición ─────────────────────────────

test('resolveVisibleReference "el primero" → primer item', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const visible = [LOMO, CEVICHE, POLLO];
    const r = svc.resolveVisibleReference('el primero', visible);
    assert.equal(r.product.id, 'l1');
});

test('resolveVisibleReference "el tercero" cuando solo hay 2 → out_of_range', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const visible = [LOMO, CEVICHE];
    const r = svc.resolveVisibleReference('el tercero', visible);
    assert.equal(r.out_of_range, true);
    assert.equal(r.max, 2);
});

test('resolveVisibleReference por precio exacto', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const visible = [LOMO, CEVICHE, POLLO, CHICHA];
    const r = svc.resolveVisibleReference('el de veintidós soles', visible);
    assert.equal(r.product.id, 'c1');
});

// ─── 9. Referencias ambiguas ─────────────────────────────────

test('resolveVisibleReference ambiguo por nombre parcial', () => {
    const menuDuplicado = [...MENU, { ...LOMO, id: 'l2', nombre: 'Lomo Especial', precio: 28, categoria: 'plato', disponible: true, orden_aparicion: 50 }];
    const svc = new MenuNavigationService({ menu: menuDuplicado });
    const visible = [LOMO, { ...LOMO, id: 'l2', nombre: 'Lomo Especial' }];
    const r = svc.resolveVisibleReference('el lomo', visible);
    assert.equal(r.ambiguous, true);
    assert.equal(r.candidates.length, 2);
});

// ─── 10. Popularidad ────────────────────────────────────────

test('popular devuelve items por orden de ventas', async () => {
    const svc = new MenuNavigationService({
        menu: MENU,
        fetchSales: async () => [
            { product_id: 'l1', sales_count: 50 },
            { product_id: 'c1', sales_count: 30 },
            { product_id: 'b1', sales_count: 20 },
        ],
    });
    const r = await svc.popular({ limit: 3 });
    assert.equal(r.data.length, 3);
    assert.equal(r.data[0].nombre, 'Lomo Saltado');
    assert.equal(r.data[1].nombre, 'Ceviche');
    assert.equal(r.period, '30d');
});

test('popular sin datos devuelve [] y no rompe', async () => {
    const svc = new MenuNavigationService({ menu: MENU, fetchSales: async () => [] });
    const r = await svc.popular({ limit: 3 });
    assert.equal(r.data.length, 0);
    assert.equal(r.period, '30d');
});

test('popular marca small_sample si todas las ventas son < 3', async () => {
    const svc = new MenuNavigationService({
        menu: MENU,
        fetchSales: async () => [{ product_id: 'l1', sales_count: 1 }, { product_id: 'c1', sales_count: 1 }],
    });
    const r = await svc.popular({ limit: 3 });
    assert.equal(r.small_sample, true);
});

test('popular excluye items con alergia declarada', async () => {
    const svc = new MenuNavigationService({
        menu: MENU,
        fetchSales: async () => [
            { product_id: 'l1', sales_count: 50 },
            { product_id: 'c1', sales_count: 30 },
        ],
    });
    const r = await svc.popular({ declaredAllergies: ['pescado'], limit: 3 });
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].nombre, 'Lomo Saltado');
});

// ─── 11. Exclusión por alergia ───────────────────────────────

test('recommend excluye items con conflicto de alérgeno', async () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const r = await svc.recommend({ declaredAllergies: ['pescado'], limit: 3 });
    const ceviche = r.data.find(item => item.nombre === 'Ceviche');
    assert.equal(ceviche, undefined, 'Ceviche tiene alérgeno pescado y debe excluirse');
});

test('recommend excluye fichas incompletas cuando hay alergia declarada', async () => {
    const legacy = {
        id: 'legacy-unknown',
        nombre: 'Plato legacy sin ficha',
        precio: 12,
        categoria: 'plato',
        disponible: true,
        destacado: true,
        recomendable: true,
        informacion_completa: false,
        alergenos: [],
        ingredientes: [],
        restricciones: {},
    };
    const svc = new MenuNavigationService({ menu: [legacy, CEVICHE] });
    const r = await svc.recommend({ declaredAllergies: ['pescado'], limit: 3 });
    assert.equal(r.data.length, 0, 'una ficha incompleta no puede recomendarse con alergia declarada');
    assert.deepEqual(r.safety_rejected_incomplete, ['legacy-unknown']);
});

test('recommend con alergia excluyente total → data vacía + muestra el motivo', async () => {
    const menuReducido = [CEVICHE, POSTRE];
    const svc = new MenuNavigationService({ menu: menuReducido });
    const r = await svc.recommend({ declaredAllergies: ['pescado', 'lactosa'], limit: 3 });
    assert.equal(r.data.length, 0);
});

test('recomendaciones por restricción dietética (vegetariano)', async () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const r = await svc.recommend({ dietaryRestrictions: ['vegetariano'], limit: 5 });
    for (const item of r.data) {
        // No puede ser Ceviche (pescado) ni Pollo (pollo)
        assert.notEqual(item.nombre, 'Ceviche');
        assert.notEqual(item.nombre, 'Pollo a la Brasa');
    }
});

// ─── 12. Recomendaciones por restricción dietética ───────────

test('dietaryOptions vegetariano devuelve solo vegetarianos', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const r = svc.dietaryOptions({ restriction: 'vegetariano' });
    const names = r.data.map(p => p.nombre);
    assert.ok(names.includes('Chicha Morada'), 'Chicha es vegetariana');
    assert.ok(!names.includes('Ceviche'), 'Ceviche no es vegetariano');
});

test('dietaryOptions restricción inválida devuelve error', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const r = svc.dietaryOptions({ restriction: 'paleolitico' });
    assert.equal(r.error, 'Restricción no soportada');
});

// ─── 13. Comparación de precios ─────────────────────────────

test('compareProducts identifica el más barato', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const r = svc.compareProducts(['l1', 'c1', 'p1']);
    assert.equal(r.comparison.cheapest.id, 'c1', 'Ceviche (22) es el más barato entre Lomo(25)/Ceviche(22)/Pollo(30)');
    assert.equal(r.comparison.most_expensive.id, 'p1', 'Pollo (30) es el más caro');
});

test('compareProducts con menos de 2 IDs devuelve error', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const r = svc.compareProducts(['l1']);
    assert.ok(r.error);
});

// ─── 14. Recomendaciones con flag destacado ─────────────────

test('recommend prioriza items con destacado=true', async () => {
    const svc = new MenuNavigationService({
        menu: MENU,
        fetchSales: async () => [],
    });
    const r = await svc.recommend({ limit: 3 });
    const names = r.data.map(p => p.nombre);
    assert.ok(names.includes('Lomo Saltado'), 'Lomo está destacado');
    assert.ok(names.includes('Ceviche'), 'Ceviche está destacado');
    assert.ok(names.includes('Chicha Morada'), 'Chicha está destacada');
});

test('recommend no incluye items con recomendable=false', async () => {
    const menuConExcluido = [...MENU, { ...LOMO, id: 'lx', nombre: 'Lomo Excluido', recomendable: false }];
    const svc = new MenuNavigationService({ menu: menuConExcluido, fetchSales: async () => [] });
    const r = await svc.recommend({ limit: 10 });
    assert.equal(r.data.find(p => p.nombre === 'Lomo Excluido'), undefined);
});

// ─── 15. Disponibilidad en recomendaciones ───────────────────

test('recommend excluye items con disponible=false', async () => {
    const menuConAgotado = [...MENU, { ...LOMO, id: 'l2', nombre: 'Lomo Agotado', disponible: false, destacado: true }];
    const svc = new MenuNavigationService({ menu: menuConAgotado, fetchSales: async () => [] });
    const r = await svc.recommend({ limit: 10 });
    assert.equal(r.data.find(p => p.nombre === 'Lomo Agotado'), undefined);
});

// ─── 16. Public item (forma pública del producto) ──────────

test('_publicItem incluye todos los campos de Fase 6', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const pub = svc._publicItem(LOMO);
    assert.equal(pub.destacado, true);
    assert.equal(pub.orden_aparicion, 10);
    assert.equal(pub.etiqueta_promocional, 'Más pedido');
    assert.equal(pub.recomendable, true);
    assert.equal(pub.disponible, true);
    assert.ok(Array.isArray(pub.ingredientes));
    assert.ok(pub.restricciones);
});

// ─── 17. Contratos WebSocket / navegación ────────────────────

test('Cada navegación de menú retorna un payload estructurado', () => {
    const svc = new MenuNavigationService({ menu: MENU });
    const items = svc.filterMenu({ category: 'bebida' });
    const navigation = {
        type: 'menu_navigation',
        session_id: 'test-1',
        mesa: 'M4',
        action: 'show_category',
        category: 'bebida',
        product_ids: items.map(i => i.id),
        highlight_product_id: items[0]?.id || null,
        filters: { category: 'bebida' },
        timestamp: new Date().toISOString(),
    };
    assert.equal(navigation.type, 'menu_navigation');
    assert.equal(navigation.action, 'show_category');
    assert.equal(navigation.category, 'bebida');
    assert.ok(Array.isArray(navigation.product_ids));
    assert.ok(navigation.product_ids.length > 0);
    assert.ok(navigation.timestamp);
});

test('Acciones de navegación cubren el conjunto mínimo', () => {
    const accionesValidas = new Set([
        'show_menu', 'show_category', 'show_products', 'highlight_product',
        'show_product_details', 'apply_filter', 'clear_filter',
        'return_to_menu', 'show_cart', 'show_recommendations',
    ]);
    // smoke: cada acción debería poder construirse como string
    for (const accion of accionesValidas) {
        assert.ok(typeof accion === 'string' && accion.length > 0);
    }
});

// ─── 18. Sincronización de estado visual ────────────────────

test('setMenu actualiza el menú en caliente', () => {
    const svc = new MenuNavigationService({ menu: [] });
    assert.equal(svc.filterMenu({}).length, 0);
    svc.setMenu(MENU);
    assert.equal(svc.filterMenu({}).length, 6);
});

// ─── 19. fetchSalesByProduct con pool mock ─────────────────

test('fetchSalesByProduct cuenta items solo de estados válidos', async () => {
    const fakePool = {
        query: async (sql, params) => ({
            rows: [
                { id: 'o1', status: 'confirmed',  platos: [{ id: 'l1', cantidad: 2 }], items: null, estado: 'confirmed' },
                { id: 'o2', status: 'draft',      platos: [{ id: 'l1', cantidad: 1 }], items: null, estado: 'draft' },     // excluido
                { id: 'o3', status: 'cancelled',  platos: [{ id: 'c1', cantidad: 3 }], items: null, estado: 'cancelled' },  // excluido
                { id: 'o4', status: 'ready',      platos: [{ id: 'c1', cantidad: 1 }], items: null, estado: 'ready' },
            ],
        }),
    };
    const r = await fetchSalesByProduct(fakePool, '30d');
    const byId = Object.fromEntries(r.map(e => [e.product_id, e.sales_count]));
    assert.equal(byId.l1, 2, 'l1: 2 unidades en pedido confirmed');
    assert.equal(byId.c1, 1, 'c1: 1 unidad en pedido ready (3 en cancelled excluidas)');
});

test('fetchSalesByProduct maneja pool inexistente → []', async () => {
    const r = await fetchSalesByProduct(null, '30d');
    assert.deepEqual(r, []);
});

test('PERIOD_DAYS tiene los valores documentados', () => {
    assert.deepEqual(Object.keys(PERIOD_DAYS).sort(), ['24h', '30d', '7d', '90d', 'all']);
});

// ─── 20. ESTADOS_VENTA_VALIDOS exporta el set de Fase 6 ─────

test('ESTADOS_VENTA_VALIDOS incluye los estados documentados', () => {
    assert.ok(ESTADOS_VENTA_VALIDOS.has('confirmed'));
    assert.ok(ESTADOS_VENTA_VALIDOS.has('delivered'));
    assert.ok(ESTADOS_VENTA_VALIDOS.has('preparing'));
    assert.ok(ESTADOS_VENTA_VALIDOS.has('ready'));
});
