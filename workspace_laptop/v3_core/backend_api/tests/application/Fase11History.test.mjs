import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OrderHistoryService,
    buildHistoryWhere,
    classifyRow,
    isMaintenanceCandidate,
    normalizeHistoryQuery,
    ordersToCsv,
    SORTS,
} from '../../src/application/OrderHistoryService.mjs';

test('Fase 11 normaliza paginación, filtros combinables y orden permitido', () => {
    const query = normalizeHistoryQuery({
        page: '2', page_size: '50', view: 'history', status: 'entregado,cancelado', table: 'mesa 8',
        date_from: '2026-07-01', date_to: '2026-07-31', order_kind: 'additional', sort: 'delivered', search: 'ceviché',
    });
    assert.equal(query.page, 2);
    assert.equal(query.page_size, 50);
    assert.deepEqual(query.statuses, ['delivered', 'cancelled']);
    assert.equal(query.table, 'M8');
    assert.equal(query.order_kind, 'additional');
    assert.equal(query.sort, 'delivered');
    assert.ok(query.date_to > query.date_from);
    assert.ok(SORTS.delivered.includes('delivered_at'));
});

test('Fase 11 excluye drafts de visitas cerradas de la vista activa', () => {
    const query = normalizeHistoryQuery({ view: 'active' });
    const where = buildHistoryWhere(query);
    assert.match(where.sql, /p\.visit_id IS NULL OR v\.status = 'active'/u);
});

test('Fase 11 rechaza límites, fechas y estados inválidos', () => {
    assert.throws(() => normalizeHistoryQuery({ page: 0 }), error => error.code === 'INVALID_HISTORY_FILTER');
    assert.throws(() => normalizeHistoryQuery({ page_size: 100000 }), error => error.code === 'INVALID_HISTORY_FILTER');
    assert.throws(() => normalizeHistoryQuery({ date_from: '2026-08-01', date_to: '2026-07-01' }), error => error.code === 'INVALID_DATE_RANGE');
    assert.throws(() => normalizeHistoryQuery({ status: 'inventado' }), error => error.code === 'INVALID_STATUS_FILTER');
});

test('Fase 11 parametriza búsqueda y no interpola texto del cliente', () => {
    const query = normalizeHistoryQuery({ view: 'all', search: "' OR 1=1 --" });
    const where = buildHistoryWhere(query);
    assert.equal(where.sql.includes("' OR 1=1"), false);
    assert.ok(where.values.some(value => value.includes("' OR 1=1")));
});

test('Fase 11 clasifica archivado permitido y protege visita activa', () => {
    const historical = classifyRow({ id: 'a', status: 'delivered', visit_id: 'v', visit_status: 'closed', is_test: false });
    const active = classifyRow({ id: 'b', status: 'preparing', visit_id: 'v', visit_status: 'active', is_test: false });
    const draft = classifyRow({ id: 'c', status: 'draft', visit_id: 'v', visit_status: 'active', session_id: 's', is_test: false });
    assert.equal(historical.can_archive, true);
    assert.equal(active.can_archive, false);
    assert.equal(active.can_delete, false);
    assert.equal(draft.can_delete, false);
    assert.equal(draft.protected_reason, 'active_visit');
});

test('Fase 11 CSV exporta campos operativos y neutraliza fórmulas', () => {
    const csv = ordersToCsv([{
        id: 'order-1', table_id: 'M8', visit_id: 'visit-1', order_kind: 'initial', status: 'delivered',
        created_at: '2026-07-01T12:00:00.000Z', confirmed_at: null, delivered_at: null,
        productos: [{ nombre: '=SUM(A1:A2)', cantidad: 1 }], total: 22, archived_at: null, data_origin: 'customer_order',
        token: 'never-export', prompt: 'never-export', allergy: 'never-export',
    }]);
    assert.match(csv, /order_id/);
    assert.match(csv, /'=SUM\(A1:A2\)/);
    assert.equal(csv.includes('never-export'), false);
    const tabFormula = ordersToCsv([{
        id: 'order-2', table_id: 'M8', status: 'delivered', productos: [{ nombre: '\t=CMD()', cantidad: 1 }], total: 1,
    }]);
    assert.match(tabFormula, /'\t=CMD\(\)/u);
});

test('Fase 11 limpieza usa updated_at, test_hours y parámetros estables', async () => {
    const queries = [];
    const fakePool = { query: async (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT * FROM order_retention_policy')) {
            return { rows: [{ id: 1, draft_hours: 24, test_hours: 12, delivered_days: 30, cancelled_days: 7, audit_days: 3650, auto_delete_historical: false }] };
        }
        return { rows: [] };
    } };
    const service = new OrderHistoryService({ pool: fakePool });
    await service._maintenanceRows();
    const maintenance = queries.at(-1);
    assert.equal(maintenance.values.length, 4);
    assert.deepEqual(maintenance.values.slice(0, 4), [24, 12, 30, 7]);
    assert.match(maintenance.sql, /COALESCE\(p\.updated_at, p\.created_at, p\.timestamp\)/u);
    assert.match(maintenance.sql, /\$2::integer \* INTERVAL '1 hour'/u);
    assert.doesNotMatch(maintenance.sql, /LIMIT \$5/u);
});

test('Fase 11 valida candidaturas nuevamente después del preview', () => {
    const policy = { draft_hours: 24, test_hours: 24, delivered_days: 30, cancelled_days: 7 };
    const now = new Date('2026-07-30T12:00:00.000Z');
    assert.equal(isMaintenanceCandidate({ status: 'draft', updated_at: '2026-07-28T00:00:00.000Z' }, { action: 'draft_delete', policy, now }), true);
    assert.equal(isMaintenanceCandidate({ status: 'draft', updated_at: '2026-07-30T11:00:00.000Z', session_id: 'active' }, { action: 'draft_delete', policy, now }), false);
    assert.equal(isMaintenanceCandidate({ status: 'draft', updated_at: '2026-07-28T00:00:00.000Z', session_id: 'closed-session', visit_id: 'closed-visit', visit_status: 'closed' }, { action: 'draft_delete', policy, now }), true);
    assert.equal(isMaintenanceCandidate({ status: 'delivered', delivered_at: '2026-06-01T00:00:00.000Z', visit_status: 'active' }, { action: 'archive_delivered', policy, now }), false);
});

test('Fase 11 política central rechaza activar borrado histórico automático', async () => {
    const queries = [];
    const fakePool = { query: async (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT * FROM order_retention_policy')) return { rows: [{ id: 1, draft_hours: 24, test_hours: 24, delivered_days: 30, cancelled_days: 7, audit_days: 3650, auto_delete_historical: false }] };
        return { rows: [] };
    } };
    const service = new OrderHistoryService({ pool: fakePool });
    await assert.rejects(() => service.updateRetentionPolicy({ auto_delete_historical: true }), error => error.code === 'AUTO_DELETE_HISTORY_FORBIDDEN');
    assert.equal(queries.length, 1);
});

test('Fase 11 notifica eventos WS con resumen de filtros', () => {
    const events = [];
    const service = new OrderHistoryService({ pool: { query: async () => ({ rows: [] }) }, notify: event => events.push(event) });
    service._notify({ event: 'test_data_cleanup_completed', count: 2, actor: 'admin', reason: 'qa', result: { deleted_tests: 2 } });
    assert.deepEqual(events.map(event => event.type), ['test_data_cleanup_completed', 'history_updated']);
    assert.deepEqual(events[0].filter_summary, {});
    assert.equal(events[0].count, 2);
});
