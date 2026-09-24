import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TABLE_IDS,
    TableVisitService,
    asTableDto,
    asVisitDto,
    normalizeTable,
} from '../../src/application/TableVisitService.mjs';
import { SessionLifecycleService } from '../../src/application/SessionLifecycleService.mjs';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';
import { classifyIntent, Intent } from '../../src/application/IntentClassifier.mjs';

test('Fase 8 define exactamente las doce mesas normalizadas', () => {
    assert.deepEqual(TABLE_IDS, ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11', 'M12']);
});

test('normaliza formatos de mesa aceptados y rechaza fuera de rango', () => {
    assert.equal(normalizeTable('mesa 8'), 'M8');
    assert.equal(normalizeTable('m12'), 'M12');
    assert.throws(() => normalizeTable('M13'), error => error.code === 'INVALID_TABLE');
    assert.throws(() => normalizeTable('barra'), error => error.code === 'INVALID_TABLE');
});

test('asTableDto conserva estado, versión y referencias JSON de la visita', () => {
    const table = asTableDto({
        table_id: 'M8',
        display_name: 'Mesa M8',
        enabled: true,
        status: 'order_confirmed',
        current_visit_id: 'visit-8',
        active_session_id: 'session-8',
        active_order_ids: '["order-1"]',
        opened_at: '2026-07-21T12:00:00.000Z',
        version: '4',
        session_count: '2',
        active_order_count: '1',
        delivered_order_count: '3',
        total_order_count: '4',
        last_activity_at: '2026-07-21T12:05:00.000Z',
        delivery_in_progress: true,
        waiter_assistance_pending: true,
        visit_id: 'visit-8',
        visit_status: 'active',
        visit_opened_at: '2026-07-21T12:00:00.000Z',
        session_ids: '["session-8"]',
        order_ids: '["order-1"]',
        additional_orders_allowed: true,
        guest_count: '2',
        visit_version: '3',
    });

    assert.equal(table.table_id, 'M8');
    assert.equal(table.status, 'order_confirmed');
    assert.deepEqual(table.active_order_ids, ['order-1']);
    assert.equal(table.version, 4);
    assert.equal(table.visit.visit_id, 'visit-8');
    assert.deepEqual(table.visit.session_ids, ['session-8']);
    assert.equal(table.visit.guest_count, 2);
    assert.equal(table.session_count, 2);
    assert.equal(table.active_order_count, 1);
    assert.equal(table.delivered_order_count, 3);
    assert.equal(table.total_order_count, 4);
    assert.equal(table.delivery_in_progress, true);
    assert.equal(table.waiter_assistance_pending, true);
});

test('asTableDto evita duplicados y convierte campos vacíos a null', () => {
    const table = asTableDto({
        table_id: 'M1',
        enabled: false,
        status: 'closed',
        current_visit_id: null,
        active_session_id: '',
        active_order_ids: '["a","a",null,"b"]',
        version: 0,
    });

    assert.deepEqual(table.active_order_ids, ['a', 'b']);
    assert.equal(table.current_visit_id, null);
    assert.equal(table.active_session_id, null);
    assert.equal(table.visit, null);
});

test('asVisitDto expone pedidos y metadatos de continuidad', () => {
    const visit = asVisitDto({
        visit_id: 'visit-1',
        table_id: 'M1',
        status: 'active',
        opened_at: '2026-07-21T12:00:00.000Z',
        session_ids: ['s1', 's1'],
        order_ids: '["o1","o1","o2"]',
        additional_orders_allowed: false,
        guest_count: 3,
        notes: 'tesis',
        version: '7',
    }, [{ id: 'o1', order_sequence: 1 }]);

    assert.equal(visit.table_id, 'M1');
    assert.deepEqual(visit.session_ids, ['s1']);
    assert.deepEqual(visit.order_ids, ['o1', 'o2']);
    assert.equal(visit.additional_orders_allowed, false);
    assert.equal(visit.orders[0].order_sequence, 1);
    assert.equal(visit.version, 7);
});

test('el cierre de sesión notifica una sola vez para desvincular active_session_id', () => {
    const manager = new OrderSessionManager({ menu: [] });
    const lifecycle = new SessionLifecycleService({
        orderSessionManager: manager,
        logger: { warn() {}, log() {} },
    });
    const calls = [];
    lifecycle.setSessionClosedHandler((session, context) => calls.push({ id: session.session_id, reason: context.reason }));
    const session = lifecycle.start({ robotId: 'qa-handler', mesa: 'M1' });

    const first = lifecycle.close({ sessionId: session.session_id, reason: 'order_confirmed' });
    const second = lifecycle.close({ sessionId: session.session_id, reason: 'order_confirmed' });

    assert.equal(first.alreadyClosed, false);
    assert.equal(second.alreadyClosed, true);
    assert.deepEqual(calls, [{ id: session.session_id, reason: 'order_confirmed' }]);
});

test('rechaza un evento de entrega con visita antigua sin mutar la mesa actual', async () => {
    const audits = [];
    const emitted = [];
    const pool = {
        query: async (sql, params) => {
            if (sql.includes('FROM restaurant_tables t')) {
                return {
                    rows: [{
                        table_id: 'M8',
                        display_name: 'Mesa M8',
                        enabled: true,
                        status: 'ready',
                        current_visit_id: 'visit-current',
                        active_session_id: null,
                        active_order_ids: '["order-current"]',
                        version: 9,
                    }],
                };
            }
            if (sql.includes('INSERT INTO pedido_eventos')) {
                audits.push({ event: params[0], metadata: JSON.parse(params[10]) });
                return { rows: [] };
            }
            throw new Error(`Consulta no esperada: ${sql}`);
        },
    };
    const service = new TableVisitService({
        pool,
        pedidoRepo: { findById: async () => ({ id: 'order-old', table_id: 'M8', visit_id: 'visit-old', status: 'ready' }) },
        sendToUI: event => emitted.push(event),
    });

    const result = await service.handleDeliveryStateChange({
        state: 'delivering',
        mesa: 'M8',
        order_id: 'order-old',
        visit_id: 'visit-old',
        origin: 'qa_stale_event',
    });

    assert.equal(result, null);
    assert.equal(audits[0].event, 'stale_delivery_event_rejected');
    assert.equal(audits[0].metadata.event_visit_id, 'visit-old');
    assert.equal(emitted[0].type, 'delivery_event_rejected');
});

test('clasifica las frases explícitas de pedido adicional por voz', () => {
    const phrases = [
        'Quiero pedir algo más',
        'Deseo agregar otra bebida',
        'Otro pedido para esta mesa',
        'Quiero añadir un postre',
        'Necesitamos pedir algo adicional',
    ];

    for (const text of phrases) {
        const classification = classifyIntent({ text });
        assert.equal(classification.intent, Intent.START_ADDITIONAL_ORDER, text);
        assert.equal(classification.mutates_order, true, text);
        assert.equal(classification.entities.additional_order, true, text);
    }
});

test('un ROBOT_BUSY al iniciar un adicional no borra la visita existente', async () => {
    const calls = [];
    const client = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
            if (sql.includes('INSERT INTO restaurant_tables')) return { rows: [] };
            if (sql.includes('SELECT * FROM restaurant_tables WHERE table_id')) {
                return { rows: [{ table_id: 'M8', display_name: 'Mesa M8', enabled: true, status: 'ordering', current_visit_id: 'visit-existing', version: 4 }] };
            }
            if (sql.includes('FROM restaurant_visits') && sql.includes("status = 'active'")) {
                return { rows: [{ visit_id: 'visit-existing', table_id: 'M8', status: 'active', additional_orders_allowed: true }] };
            }
            if (sql.includes('UPDATE restaurant_tables')) return { rows: [] };
            throw new Error(`Consulta no esperada: ${sql}`);
        },
        release() {},
    };
    const service = new TableVisitService({
        pool: {
            connect: async () => client,
            query: async () => { throw new Error('No debe consultar el pool fuera de la transacción'); },
        },
        pedidoRepo: {},
        sessionLifecycle: {
            start() {
                const error = new Error('robot ocupado');
                error.code = 'ROBOT_BUSY';
                throw error;
            },
        },
    });

    await assert.rejects(
        service.startAdditionalOrder({ tableId: 'M8', robotId: 'uchino-01', source: 'test' }),
        error => error.code === 'ROBOT_BUSY',
    );
    assert.equal(calls.some(call => call.sql.includes('DELETE FROM restaurant_visits')), false);
    assert.equal(calls.some(call => call.sql.includes("status = 'available'")), false);
});

test('rechaza asociar una sesión si la mesa ya cambió de visita', async () => {
    const calls = [];
    const client = {
        async query(sql) {
            calls.push(sql);
            if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
            if (sql.includes('SELECT current_visit_id')) return { rows: [{ current_visit_id: 'visit-old' }] };
            if (sql.includes('SELECT session_ids')) return { rows: [{ session_ids: [] }] };
            if (sql.includes('UPDATE restaurant_visits')) return { rows: [] };
            if (sql.includes('UPDATE restaurant_tables')) return { rows: [] };
            throw new Error(`Consulta no esperada: ${sql}`);
        },
        release() {},
    };
    const service = new TableVisitService({
        pool: { connect: async () => client },
        pedidoRepo: {},
    });

    await assert.rejects(
        service._attachSession('visit-old', 'M8', 'session-new', 'qa', false),
        error => error.code === 'STALE_VISIT',
    );
    assert.equal(calls.includes('COMMIT'), false);
    assert.equal(calls.at(-1), 'ROLLBACK');
    assert.ok(calls.findIndex(sql => sql.includes('SELECT current_visit_id')) < calls.findIndex(sql => sql.includes('SELECT session_ids')));
});

test('un pedido con visit_id obsoleto no crea una visita nueva', async () => {
    const calls = [];
    const client = {
        async query(sql) {
            calls.push(sql);
            if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
            if (sql.includes('INSERT INTO restaurant_tables')) return { rows: [] };
            if (sql.includes('SELECT * FROM restaurant_tables WHERE table_id')) {
                return { rows: [{ table_id: 'M8', enabled: true, status: 'available', current_visit_id: null }] };
            }
            if (sql.includes('SELECT * FROM restaurant_visits WHERE visit_id')) return { rows: [] };
            throw new Error(`Consulta no esperada: ${sql}`);
        },
        release() {},
    };
    const service = new TableVisitService({
        pool: { connect: async () => client },
        pedidoRepo: {},
    });

    await assert.rejects(
        service.attachOrder({
            order: { id: 'order-stale', table_id: 'M8', visit_id: 'visit-old', status: 'draft' },
            source: 'qa_stale_visit',
        }),
        error => error.code === 'STALE_VISIT',
    );
    assert.equal(calls.some(sql => sql.includes('INSERT INTO restaurant_visits')), false);
});

test('cierre forzado confirmado cancela pendientes dentro de la misma transacción y conserva historial', async () => {
    const audits = [];
    const tableRow = {
        table_id: 'M8', display_name: 'Mesa M8', enabled: true, status: 'ready',
        current_visit_id: 'visit-force', active_session_id: null, active_order_ids: '["order-force"]', version: 5,
    };
    const visitRow = {
        visit_id: 'visit-force', table_id: 'M8', status: 'active', session_ids: [],
        order_ids: ['order-force'], additional_orders_allowed: true, version: 2,
    };
    const client = {
        async query(sql, params = []) {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
            if (sql.includes('INSERT INTO restaurant_tables')) return { rows: [] };
            if (sql.includes('SELECT * FROM restaurant_tables WHERE table_id')) return { rows: [tableRow] };
            if (sql.includes('SELECT * FROM restaurant_visits WHERE table_id')) return { rows: [visitRow] };
            if (sql.includes('SELECT id, status FROM pedidos WHERE visit_id')) return { rows: [{ id: 'order-force', status: 'ready' }] };
            if (sql.includes('INSERT INTO pedido_eventos')) {
                audits.push({ event: params[0], orderId: params[2] || null });
                return { rows: [] };
            }
            if (sql.includes('UPDATE pedidos')) return { rows: [{ id: 'order-force' }] };
            if (sql.includes('UPDATE restaurant_visits')) return { rows: [visitRow] };
            if (sql.includes('UPDATE restaurant_tables')) return { rows: [] };
            throw new Error(`Consulta no esperada: ${sql}`);
        },
        release() {},
    };
    const service = new TableVisitService({
        pool: {
            connect: async () => client,
            query: async sql => {
                if (sql.includes('FROM restaurant_tables t')) {
                    return { rows: [{ ...tableRow, status: 'available', current_visit_id: null, active_session_id: null, active_order_ids: '[]' }] };
                }
                if (sql.includes('SELECT * FROM restaurant_visits WHERE table_id')) return { rows: [{ ...visitRow, status: 'closed' }] };
                throw new Error(`Consulta de pool no esperada: ${sql}`);
            },
        },
        pedidoRepo: {
            findAll: async () => ({ data: [{ id: 'order-force', status: 'cancelled' }], total: 1 }),
        },
    });

    const result = await service.closeVisit({
        tableId: 'M8', visitId: 'visit-force', source: 'admin',
        reason: 'datos de prueba', force: true, confirmation: true,
    });

    assert.equal(result.blocked, false);
    assert.equal(result.table.status, 'available');
    assert.deepEqual(result.visit.orders, [{ id: 'order-force', status: 'cancelled' }]);
    assert.deepEqual(audits.filter(audit => audit.event === 'order_force_cancelled'), [{ event: 'order_force_cancelled', orderId: 'order-force' }]);
});

test('Cocina y ROS solo reciben pedidos de visitas activas', async () => {
    const queries = [];
    const pool = {
        query: async (sql, params) => {
            queries.push({ sql, params });
            return { rows: [{ id: 'order-active', status: 'ready', visit_id: 'visit-active' }] };
        },
    };
    const service = new TableVisitService({
        pool,
        pedidoRepo: { _toEntity: row => ({ ...row, mapped: true }) },
    });

    const orders = await service.listKitchenOrders({ statuses: ['ready'] });

    assert.equal(orders.length, 1);
    assert.equal(orders[0].id, 'order-active');
    assert.equal(orders[0].status, 'ready');
    assert.equal(orders[0].visit_id, 'visit-active');
    assert.equal(Object.hasOwn(orders[0], 'mapped'), false);
    assert.match(queries[0].sql, /restaurant_visits v/);
    assert.match(queries[0].sql, /v\.status = 'active'/);
    assert.deepEqual(queries[0].params, [['ready']]);
});
