import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderHistoryService } from '../../src/application/OrderHistoryService.mjs';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const VISIT_ID = '22222222-2222-4222-8222-222222222222';
const POLICY = {
    id: 1,
    draft_hours: 24,
    test_hours: 24,
    delivered_days: 30,
    cancelled_days: 7,
    audit_days: 3650,
    auto_delete_historical: false,
};

const baseOrder = {
    id: ORDER_ID,
    mesa: 'M8',
    table_id: 'M8',
    visit_id: VISIT_ID,
    status: 'delivered',
    estado: 'entregado',
    items: [{ nombre: 'Ceviche', cantidad: 1, precio: 22 }],
    platos: [{ nombre: 'Ceviche', cantidad: 1, precio: 22 }],
    subtotal: 22,
    total: 22,
    timestamp: '2026-07-01T12:00:00.000Z',
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
    delivered_at: '2026-07-01T12:00:00.000Z',
    is_test: false,
    data_origin: 'customer_order',
    retention_class: 'operational',
    visit_status: 'closed',
    visit_closed_at: '2026-07-01T13:00:00.000Z',
};

const visit = {
    visit_id: VISIT_ID,
    table_id: 'M8',
    status: 'closed',
    opened_at: '2026-07-01T11:00:00.000Z',
    closed_at: '2026-07-01T13:00:00.000Z',
    close_reason: 'served',
    guest_count: 2,
    is_test: false,
};

function compact(sql) {
    return sql.replace(/\s+/gu, ' ').trim();
}

function makeReadPool() {
    const calls = [];
    return {
        calls,
        query: async (sql) => {
            const statement = compact(sql);
            calls.push(statement);
            if (statement.startsWith('INSERT INTO pedido_eventos')) return { rows: [] };
            if (statement.includes('FROM pedido_eventos') && statement.includes('COUNT(*) OVER()')) {
                return { rows: [{ id: '33333333-3333-4333-8333-333333333333', event: 'history_viewed', order_id: ORDER_ID, actor: 'admin', timestamp: baseOrder.timestamp, metadata: {}, total_count: 1 }] };
            }
            if (statement.includes('FROM pedido_eventos') && statement.includes('COUNT(*)::integer AS total_count')) {
                return { rows: [{ total_count: 1 }] };
            }
            if (statement.startsWith('SELECT * FROM restaurant_visits')) return { rows: [visit] };
            if (statement.includes('EXTRACT(HOUR')) return { rows: [] };
            if (statement.includes('jsonb_array_elements')) return { rows: [{ nombre: 'Ceviche', cantidad: '1' }] };
            if (statement.includes('COUNT(*)::integer AS order_count') && statement.includes('FROM pedidos')) {
                return { rows: [{ order_count: 1, total_amount: '22', initial_count: 1, additional_count: 0, delivered_count: 1 }] };
            }
            if (statement.includes('FROM pedidos p LEFT JOIN restaurant_visits')) return { rows: [{ ...baseOrder, total_count: 1 }] };
            return { rows: [] };
        },
    };
}

function makeTransactionalPool({ current, returned = current, deleted = null }) {
    const calls = [];
    let firstSelect = true;
    const client = {
        query: async (sql) => {
            const statement = compact(sql);
            calls.push(`client:${statement}`);
            if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [] };
            if (statement.includes('SELECT p.*, v.status AS visit_status')) {
                const row = firstSelect ? current : returned;
                firstSelect = false;
                return { rows: [row] };
            }
            if (statement.includes('SELECT * FROM pedidos WHERE id = $1')) return { rows: [current] };
            if (statement.includes('SELECT status FROM restaurant_visits')) return { rows: [] };
            if (statement.startsWith('UPDATE pedidos SET archived_at = NULL')) return { rows: [returned] };
            if (statement.startsWith('UPDATE pedidos SET archived_at = NOW()')) return { rows: [returned] };
            if (statement.startsWith('DELETE FROM pedidos')) return { rows: deleted ? [deleted] : [] };
            if (statement.startsWith('INSERT INTO pedido_eventos')) return { rows: [] };
            return { rows: [] };
        },
        release() {},
    };
    return {
        calls,
        query: async (sql) => {
            const statement = compact(sql);
            calls.push(`pool:${statement}`);
            if (statement.startsWith('INSERT INTO pedido_eventos')) return { rows: [] };
            if (statement.includes('SELECT p.*, v.status AS visit_status')) return { rows: [returned] };
            return { rows: [] };
        },
        connect: async () => client,
    };
}

function makeRetentionPool() {
    const calls = [];
    const policyRow = { ...POLICY };
    const dispatch = async (sql) => {
        const statement = compact(sql);
        calls.push(statement);
        if (statement.startsWith('SELECT * FROM order_retention_policy')) return { rows: [policyRow] };
        if (statement.startsWith('INSERT INTO pedido_eventos')) return { rows: [] };
        if (statement.includes('FROM pedidos p LEFT JOIN restaurant_visits')) return { rows: [] };
        if (statement.includes('FROM restaurant_visits')) return { rows: [] };
        if (statement.includes('FROM customer_profiles')) return { rows: [] };
        if (statement.includes('FROM pedido_eventos')) return { rows: [] };
        return { rows: [] };
    };
    const client = {
        query: async (sql) => {
            const statement = compact(sql);
            calls.push(`client:${statement}`);
            if (statement === 'BEGIN' || statement === 'COMMIT' || statement === 'ROLLBACK') return { rows: [] };
            if (statement.startsWith('SELECT pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] };
            return dispatch(sql);
        },
        release() {},
    };
    return { calls, query: dispatch, connect: async () => client };
}

test('Fase 11 operaciones de lectura cubren historial, resumen, exportación, auditoría y visita', async () => {
    const pool = makeReadPool();
    const service = new OrderHistoryService({ pool });
    const list = await service.listOrders({ view: 'history' }, { audit: false });
    const summary = await service.summary();
    const order = await service.getOrder(ORDER_ID);
    const csv = await service.exportOrders({}, { actor: 'export-read-test' });
    const audit = await service.audit({ actor: 'audit-read-test' });
    const history = await service.visitHistory(VISIT_ID, {}, { actor: 'visit-read-test' });

    assert.equal(list.items.length, 1);
    assert.equal(summary.order_count, 1);
    assert.equal(order.id, ORDER_ID);
    assert.match(csv, /order_id/u);
    assert.equal(audit.items.length, 1);
    assert.equal(history.visit.visit_id, VISIT_ID);
    assert.equal(history.summary.order_count, 1);
});

test('Fase 11 archiva y desarchiva una orden histórica con motivo', async () => {
    const archivedRow = { ...baseOrder, archived_at: '2026-07-30T12:00:00.000Z', archived_by: 'admin', archive_reason: 'qa' };
    const archiveService = new OrderHistoryService({ pool: makeTransactionalPool({ current: baseOrder, returned: archivedRow }) });
    const archived = await archiveService.archiveOrder(ORDER_ID, { reason: 'qa' });
    assert.equal(archived.archived, true);
    assert.equal(archived.order.archived_at, archivedRow.archived_at);

    const unarchiveService = new OrderHistoryService({ pool: makeTransactionalPool({ current: archivedRow, returned: baseOrder }) });
    const unarchived = await unarchiveService.unarchiveOrder(ORDER_ID, { reason: 'qa correction' });
    assert.equal(unarchived.unarchived, true);
    assert.equal(unarchived.order.archived_at, null);
});

test('Fase 11 permite borrar un test draft y rechaza borrar un histórico real', async () => {
    const draft = { ...baseOrder, status: 'draft', estado: 'provisional', visit_id: null, visit_status: null, is_test: true };
    const draftService = new OrderHistoryService({
        pool: makeTransactionalPool({ current: draft, deleted: { id: ORDER_ID, visit_id: null, is_test: true } }),
    });
    const deleted = await draftService.deleteOrder(ORDER_ID, { confirm: true, reason: 'qa draft' });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.is_test, true);

    const protectedService = new OrderHistoryService({ pool: makeTransactionalPool({ current: baseOrder }) });
    await assert.rejects(
        () => protectedService.deleteOrder(ORDER_ID, { confirm: true, reason: 'qa protected' }),
        error => error.code === 'PROTECTED_ORDER_DELETE',
    );
});

test('Fase 11 preview y ejecución de limpieza usan token, confirmación y resumen', async () => {
    const service = new OrderHistoryService({ pool: makeRetentionPool() });
    const preview = await service.previewCleanup({ kind: 'test', actor: 'retention-test' });
    assert.equal(preview.kind, 'test');
    assert.equal(preview.summary.count, 0);
    const result = await service.executeCleanup({
        previewToken: preview.preview_token,
        actor: 'retention-test',
        confirm: true,
        reason: 'qa cleanup',
    });
    assert.equal(result.deleted_tests, 0);
    await assert.rejects(
        () => service.executeCleanup({ previewToken: preview.preview_token, actor: 'retention-reuse', confirm: true, reason: 'qa reuse' }),
        error => error.code === 'STALE_CLEANUP_PREVIEW',
    );
});

test('Fase 11 actualización de retención bloquea borrado histórico automático y guarda política', async () => {
    const pool = makeRetentionPool();
    const service = new OrderHistoryService({ pool });
    await assert.rejects(
        () => service.updateRetentionPolicy({ auto_delete_historical: true }),
        error => error.code === 'AUTO_DELETE_HISTORY_FORBIDDEN',
    );
    const updated = await service.updateRetentionPolicy({ test_hours: 48 }, { reason: 'qa policy' });
    assert.equal(updated.test_hours, 24);
    assert.ok(pool.calls.some(call => call.includes('FOR UPDATE')));
});
