import { normalizeMesa } from './OrderSessionManager.mjs';

const TABLE_IDS = Object.freeze(Array.from({ length: 12 }, (_, index) => `M${index + 1}`));
const BLOCKING_ORDER_STATUSES = new Set([
    'draft',
    'pending_confirmation',
    'confirmed',
    'sent_to_kitchen',
    'preparing',
    'ready',
    'delivery_in_progress',
]);
const STATUS_PRIORITY = [
    ['delivery_in_progress', 'delivery_in_progress'],
    ['ready', 'ready'],
    ['preparing', 'preparing'],
    ['sent_to_kitchen', 'order_confirmed'],
    ['confirmed', 'order_confirmed'],
    ['draft', 'ordering'],
    ['pending_confirmation', 'ordering'],
];

function parseJson(value, fallback = []) {
    if (Array.isArray(value) || (value && typeof value === 'object')) return value;
    if (typeof value !== 'string') return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

function uniqueStrings(values = []) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

function redactPublicKitchenText(value) {
    return String(value ?? '')
        .replace(/\b(?:session(?:_id)?|visit(?:_id)?|sesi[oó]n|visita)\s*[:=]\s*[A-Za-z0-9_-]+/giu, match => match.replace(/[:=].*$/u, ': [redacted]'))
        .slice(0, 2000);
}

/**
 * Cocina necesita la orden y las advertencias operativas, pero no la identidad
 * de la sesión ni datos de cliente. La proyección en backend evita confiar
 * únicamente en que el frontend descarte campos sensibles.
 */
export function projectKitchenOrder(order = {}) {
    return {
        id: order.id,
        mesa: order.mesa || order.table_id || null,
        table_id: order.table_id || order.mesa || null,
        platos: order.platos || order.items || [],
        items: order.items || order.platos || [],
        status: order.status || order.estado || null,
        estado: order.estado || null,
        timestamp: order.timestamp || null,
        total: order.total ?? null,
        subtotal: order.subtotal ?? null,
        notes: order.notes ?? order.notas ?? '',
        notas: order.notas ?? order.notes ?? '',
        requires_human: Boolean(order.requires_human),
        visit_id: order.visit_id || null,
        guest_count: order.guest_count || null,
        order_sequence: order.order_sequence || null,
        order_kind: order.order_kind || null,
        declared_allergies: order.declared_allergies || [],
        dietary_restrictions: order.dietary_restrictions || [],
        allergy_conflicts: order.allergy_conflicts || [],
        special_warning: order.special_warning || '',
        requires_special_confirmation: Boolean(order.requires_special_confirmation),
    };
}

export function projectPublicKitchenOrder(order = {}) {
    const { visit_id: _visitId, ...safeOrder } = projectKitchenOrder(order);
    for (const field of [
        'declared_allergies',
        'dietary_restrictions',
        'allergy_conflicts',
        'special_warning',
        'requires_special_confirmation',
    ]) delete safeOrder[field];
    safeOrder.notes = redactPublicKitchenText(safeOrder.notes);
    safeOrder.notas = safeOrder.notes;
    return safeOrder;
}

export function projectPublicTableAvailability(table = {}) {
    return {
        table_id: table.table_id || null,
        display_name: table.display_name || table.table_id || null,
        enabled: table.enabled !== false,
        status: table.status || 'available',
        last_status_changed_at: table.last_status_changed_at || null,
        version: Number(table.version || 0),
        delivery_in_progress: Boolean(table.delivery_in_progress),
    };
}

function serviceError(message, code, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

function normalizeTable(value) {
    try {
        const tableId = normalizeMesa(value);
        if (!tableId || !TABLE_IDS.includes(tableId)) throw new Error(`Mesa inválida: ${value}`);
        return tableId;
    } catch {
        throw serviceError(`Mesa inválida: ${value}. Usa M1 a M12.`, 'INVALID_TABLE');
    }
}

function asTableDto(row) {
    if (!row) return null;
    return {
        table_id: row.table_id,
        display_name: row.display_name,
        enabled: Boolean(row.enabled),
        status: row.status,
        current_visit_id: row.current_visit_id || null,
        active_session_id: row.active_session_id || null,
        active_order_ids: uniqueStrings(parseJson(row.active_order_ids)),
        opened_at: row.opened_at || null,
        last_status_changed_at: row.last_status_changed_at || null,
        version: Number(row.version || 0),
        session_count: Number(row.session_count || 0),
        active_order_count: Number(row.active_order_count || 0),
        delivered_order_count: Number(row.delivered_order_count || 0),
        total_order_count: Number(row.total_order_count || 0),
        last_activity_at: row.last_activity_at || row.last_order_activity || null,
        delivery_in_progress: Boolean(row.delivery_in_progress),
        waiter_assistance_pending: Boolean(row.waiter_assistance_pending),
        visit: row.visit_id ? {
            visit_id: row.visit_id,
            status: row.visit_status || 'active',
            opened_at: row.visit_opened_at || null,
            closed_at: row.visit_closed_at || null,
            close_reason: row.visit_close_reason || null,
            session_ids: uniqueStrings(parseJson(row.session_ids)),
            order_ids: uniqueStrings(parseJson(row.order_ids)),
            additional_orders_allowed: row.additional_orders_allowed !== false,
            guest_count: row.guest_count === null || row.guest_count === undefined ? null : Number(row.guest_count),
            version: Number(row.visit_version || 0),
        } : null,
    };
}

function asVisitDto(row, orders = []) {
    if (!row) return null;
    return {
        visit_id: row.visit_id,
        table_id: row.table_id,
        status: row.status,
        opened_at: row.opened_at,
        closed_at: row.closed_at || null,
        close_reason: row.close_reason || null,
        session_ids: uniqueStrings(parseJson(row.session_ids)),
        order_ids: uniqueStrings(parseJson(row.order_ids)),
        additional_orders_allowed: row.additional_orders_allowed !== false,
        guest_count: row.guest_count === null || row.guest_count === undefined ? null : Number(row.guest_count),
        notes: row.notes || '',
        version: Number(row.version || 0),
        orders,
    };
}

export class TableVisitService {
    constructor({
        pool,
        pedidoRepo,
        sendToUI = null,
        sessionLifecycle = null,
        waiterAssistanceService = null,
        robotStateManager = null,
        logger = console,
        autoReleaseAfterDelivery = false,
    } = {}) {
        if (!pool) throw new Error('TableVisitService requiere pool PostgreSQL');
        this.pool = pool;
        this.pedidoRepo = pedidoRepo;
        this.sendToUI = typeof sendToUI === 'function' ? sendToUI : null;
        this.sessionLifecycle = sessionLifecycle;
        this.waiterAssistanceService = waiterAssistanceService;
        this.robotStateManager = robotStateManager;
        this.logger = logger;
        this.autoReleaseAfterDelivery = Boolean(autoReleaseAfterDelivery);
    }

    setSessionLifecycle(sessionLifecycle) {
        this.sessionLifecycle = sessionLifecycle;
    }

    setWaiterAssistanceService(waiterAssistanceService) {
        this.waiterAssistanceService = waiterAssistanceService;
    }

    setRobotStateManager(robotStateManager) {
        this.robotStateManager = robotStateManager;
    }

    _assertRobotCanMove(sessionId, mesa) {
        if (!this.robotStateManager?.canMoveAttention) return;
        const result = this.robotStateManager.canMoveAttention({ sessionId, mesa });
        if (result?.ok === false) throw serviceError(result.error, 'ROBOT_STATE_CONFLICT');
    }

    async listTables({ status = null, enabled = null } = {}) {
        const values = [];
        const where = [];
        if (status) { values.push(status); where.push(`t.status = $${values.length}`); }
        if (enabled !== null && enabled !== undefined) { values.push(Boolean(enabled)); where.push(`t.enabled = $${values.length}`); }
        const query = `
            SELECT t.*, v.visit_id, v.status AS visit_status, v.opened_at AS visit_opened_at,
                   v.closed_at AS visit_closed_at, v.close_reason AS visit_close_reason,
                   v.session_ids, v.order_ids, v.additional_orders_allowed,
                   v.guest_count, v.version AS visit_version,
                   COALESCE(jsonb_array_length(v.session_ids), 0) AS session_count,
                   COALESCE(order_summary.active_order_count, 0) AS active_order_count,
                   COALESCE(order_summary.delivered_order_count, 0) AS delivered_order_count,
                   COALESCE(order_summary.total_order_count, 0) AS total_order_count,
                   order_summary.last_order_activity,
                   COALESCE(order_summary.delivery_in_progress, false) AS delivery_in_progress,
                   GREATEST(v.updated_at, COALESCE(order_summary.last_order_activity, v.updated_at)) AS last_activity_at
              FROM restaurant_tables t
              LEFT JOIN restaurant_visits v ON v.visit_id = t.current_visit_id AND v.status = 'active'
              LEFT JOIN LATERAL (
                  SELECT COUNT(*) FILTER (WHERE p.status NOT IN ('delivered', 'cancelled'))::integer AS active_order_count,
                         COUNT(*) FILTER (WHERE p.status = 'delivered')::integer AS delivered_order_count,
                         COUNT(*)::integer AS total_order_count,
                         MAX(p.timestamp) AS last_order_activity,
                         BOOL_OR(p.status = 'delivery_in_progress') AS delivery_in_progress
                    FROM pedidos p
                   WHERE p.visit_id = v.visit_id
              ) order_summary ON TRUE
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY t.table_id`;
        const result = await this.pool.query(query, values);
        const pendingWaiterTables = new Set();
        if (this.waiterAssistanceService?.list && result.rows.length > 0) {
            const requests = await this.waiterAssistanceService.list({ status: 'pending' }).catch(() => []);
            for (const row of result.rows) {
                const currentVisitId = row.visit_id || null;
                const currentSessionIds = uniqueStrings(parseJson(row.session_ids));
                const currentRobotIds = currentSessionIds
                    .map(sessionId => this.sessionLifecycle?.get?.(sessionId)?.assignment?.robot_id || null)
                    .filter(Boolean);
                const matched = requests.some(request => {
                    if (!currentVisitId || !request.visit_id || request.visit_id !== currentVisitId) return false;
                    if (!request.session_id || !currentSessionIds.includes(request.session_id)) return false;
                    if (!request.table_id || request.table_id !== row.table_id) return false;
                    if (!request.robot_id || currentRobotIds.length === 0 || !currentRobotIds.includes(request.robot_id)) return false;
                    return request.mesa === row.table_id;
                });
                if (matched) pendingWaiterTables.add(row.table_id);
            }
        }
        return result.rows.map(row => asTableDto({
            ...row,
            waiter_assistance_pending: pendingWaiterTables.has(row.table_id),
        }));
    }

    async getTable(tableId) {
        const normalized = normalizeTable(tableId);
        const tables = await this.listTables();
        return tables.find(table => table.table_id === normalized) || null;
    }

    async getVisit(tableId, visitId) {
        const normalized = normalizeTable(tableId);
        const visitResult = await this.pool.query(
            'SELECT * FROM restaurant_visits WHERE table_id = $1 AND visit_id = $2',
            [normalized, visitId],
        );
        if (!visitResult.rows[0]) return null;
        const { data: orders } = await this.pedidoRepo.findAll({ visit_id: visitId }, { orderBy: 'order_sequence ASC NULLS LAST, timestamp ASC' });
        return asVisitDto(visitResult.rows[0], orders);
    }

    async history(tableId, { limit = 20, offset = 0 } = {}) {
        const page = await this.historyPage(tableId, { limit, offset });
        return page.data;
    }

    async historyPage(tableId, { limit = 20, offset = 0 } = {}) {
        const normalized = normalizeTable(tableId);
        const pageLimit = Math.min(100, Math.max(1, Number(limit) || 20));
        const pageOffset = Math.max(0, Number(offset) || 0);
        const result = await this.pool.query(
            `SELECT *, COUNT(*) OVER()::integer AS total_count
               FROM restaurant_visits
              WHERE table_id = $1
              ORDER BY opened_at DESC
              LIMIT $2 OFFSET $3`,
            [normalized, pageLimit, pageOffset],
        );
        const output = [];
        for (const row of result.rows) {
            output.push(await this.getVisit(normalized, row.visit_id));
        }
        const total = Number(result.rows[0]?.total_count || 0);
        return { data: output, total, limit: pageLimit, offset: pageOffset, has_more: pageOffset + output.length < total };
    }

    async listKitchenOrders({ statuses = ['sent_to_kitchen', 'preparing', 'ready'] } = {}) {
        const allowedStatuses = statuses.filter(status => ['sent_to_kitchen', 'preparing', 'ready'].includes(status));
        if (allowedStatuses.length === 0) return [];
        const result = await this.pool.query(
            `SELECT p.*
               FROM pedidos p
               JOIN restaurant_visits v
                 ON v.visit_id = p.visit_id AND v.status = 'active'
               JOIN restaurant_tables t
                 ON t.table_id = p.table_id
                AND t.current_visit_id = v.visit_id
                AND t.enabled = true
              WHERE p.status = ANY($1::text[])
                AND p.archived_at IS NULL
                AND p.deleted_at IS NULL
              ORDER BY p.timestamp ASC`,
            [allowedStatuses],
        );
        return result.rows.map(row => projectKitchenOrder(this.pedidoRepo?._toEntity?.(row) || row));
    }

    async isCurrentOrder(order) {
        if (!order?.id || !order.visit_id || !(order.table_id || order.mesa)) return false;
        const table = await this.getTable(order.table_id || order.mesa);
        return Boolean(
            table
            && table.current_visit_id === order.visit_id
            && table.active_order_ids.includes(String(order.id))
            && table.visit?.status === 'active',
        );
    }

    async startVisit({ tableId, robotId = 'uchino-01', source = 'manual', additionalOrder = false, guestCount = null } = {}) {
        const normalized = normalizeTable(tableId);
        let visit = null;
        let table = null;
        let created = false;
        let session = null;
        if (this.sessionLifecycle) {
            // Reserve the robot before opening the database transaction. This
            // keeps concurrent starts for the same robot out of the
            // table->visit lock path and prevents a split-transaction deadlock.
            session = this.sessionLifecycle.start({
                robotId,
                mesa: normalized,
                source,
                replaceExisting: false,
                guestCount,
            });
        }
        let client = null;
        try {
            client = await this.pool.connect();
            await client.query('BEGIN');
            table = await this._lockTable(client, normalized);
            if (!table.enabled) throw serviceError(`La mesa ${normalized} está deshabilitada.`, 'TABLE_DISABLED');
            const activeVisitResult = await client.query(
                `SELECT * FROM restaurant_visits
                  WHERE table_id = $1 AND status = 'active'
                  ORDER BY opened_at ASC LIMIT 1 FOR UPDATE`,
                [normalized],
            );
            visit = activeVisitResult.rows[0] || null;
            if (!additionalOrder && visit) {
                await this._recordAudit(client, {
                    event: 'duplicate_visit_rejected', mesa: normalized, actor: 'user', source,
                    previousState: { status: table.status, visit_id: visit.visit_id },
                    nextState: { status: table.status, visit_id: visit.visit_id },
                    metadata: { robot_id: robotId },
                });
                throw serviceError(`Mesa ${normalized} ya tiene una atención activa. Puedes continuar la visita o agregar un pedido adicional.`, 'TABLE_OCCUPIED', { visit_id: visit.visit_id });
            }
            if (additionalOrder && !visit) {
                throw serviceError(`La mesa ${normalized} no tiene una visita activa para agregar un pedido.`, 'NO_ACTIVE_VISIT');
            }
            if (additionalOrder && visit && !visit.additional_orders_allowed) {
                throw serviceError(`La visita de ${normalized} no permite pedidos adicionales.`, 'ADDITIONAL_ORDERS_DISABLED');
            }
            if (!visit) {
                await this._recordAudit(client, {
                    event: 'visit_start_requested', mesa: normalized, actor: 'user', source,
                    previousState: { status: table.status }, nextState: { status: 'ordering' },
                    metadata: { robot_id: robotId, guest_count: guestCount },
                });
                const createdVisit = await client.query(
                    `INSERT INTO restaurant_visits (table_id, guest_count)
                     VALUES ($1, $2::integer)
                     RETURNING *`,
                    [normalized, guestCount || null],
                );
                visit = createdVisit.rows[0];
                created = true;
                await this._recordAudit(client, {
                    event: 'visit_started', mesa: normalized, actor: 'user', source,
                    previousState: { status: table.status }, nextState: { status: 'ordering', visit_id: visit.visit_id },
                    metadata: { robot_id: robotId, guest_count: guestCount },
                });
            }
            const nextStatus = table.status === 'available' || table.status === 'closed' || created
                ? 'ordering'
                : table.status;
            await client.query(
                `UPDATE restaurant_tables
                    SET current_visit_id = $1::uuid, status = $2::varchar,
                        opened_at = COALESCE(opened_at, NOW()),
                        last_status_changed_at = CASE WHEN status <> $2::varchar THEN NOW() ELSE last_status_changed_at END,
                        version = version + 1, updated_at = NOW()
                  WHERE table_id = $3::varchar`,
                [visit.visit_id, nextStatus, normalized],
            );
            await client.query('COMMIT');
        } catch (error) {
            await client?.query('ROLLBACK').catch(() => {});
            if (session?.session_id) {
                this.sessionLifecycle.close({
                    sessionId: session.session_id,
                    reason: 'table_visit_start_failed',
                    source,
                });
            }
            if (error.code === 'TABLE_OCCUPIED') {
                await this._recordAudit(null, {
                    event: 'duplicate_visit_rejected', mesa: normalized, actor: 'user', source,
                    previousState: { status: table?.status || 'occupied', visit_id: error.visit_id || null },
                    nextState: { status: table?.status || 'occupied', visit_id: error.visit_id || null },
                    metadata: { robot_id: robotId },
                });
            }
            throw error;
        } finally {
            client?.release();
        }

        if (this.sessionLifecycle) {
            try {
                if (additionalOrder && session.guest_count == null && visit.guest_count != null) {
                    this.sessionLifecycle.setGuestCount(session.session_id, Number(visit.guest_count));
                }
                session.visit_id = visit.visit_id;
                await this._attachSession(visit.visit_id, normalized, session.session_id, source, additionalOrder);
                this.sessionLifecycle.notifyRobotVisitAttached?.(session.session_id, visit.visit_id);
            } catch (error) {
                if (session?.session_id) {
                    this.sessionLifecycle.close({
                        sessionId: session.session_id,
                        reason: 'table_session_attach_failed',
                        source,
                    });
                }
                if (created) await this._rollbackVisitWithoutOrders(visit.visit_id, normalized, source);
                throw error;
            }
        }
        const snapshot = await this.getTable(normalized);
        this._emit(additionalOrder ? 'additional_order_started' : 'table_visit_started', {
            table: snapshot,
            tableId: normalized,
            visitId: visit.visit_id,
            sessionId: session?.session_id || null,
            source,
            reason: additionalOrder ? 'additional_order' : 'initial_order',
            previousStatus: table?.status || null,
        });
        return { table: snapshot, visit: await this.getVisit(normalized, visit.visit_id), session };
    }

    async startAdditionalOrder(params = {}) {
        return this.startVisit({ ...params, additionalOrder: true, source: params.source || 'additional_order' });
    }

    async continueVisit({ tableId, visitId, robotId = 'uchino-01', source = 'manual', guestCount = null } = {}) {
        const normalized = normalizeTable(tableId);
        const visit = await this.getVisit(normalized, visitId);
        if (!visit || visit.status !== 'active') throw serviceError(`Visita no encontrada para ${normalized}.`, 'VISIT_NOT_FOUND');
        const table = await this.getTable(normalized);
        const existingSession = table?.active_session_id && this.sessionLifecycle?.get?.(table.active_session_id);
        if (existingSession && !['closed', 'expired'].includes(existingSession.session_status)) {
            return { table, visit, session: existingSession, continued: true };
        }
        let session = null;
        if (this.sessionLifecycle) {
            try {
                session = this.sessionLifecycle.start({ robotId, mesa: normalized, source, replaceExisting: false, visitId, guestCount: guestCount ?? visit.guest_count ?? null });
                session.visit_id = visitId;
                await this._attachSession(visitId, normalized, session.session_id, source, false);
            } catch (error) {
                if (session?.session_id) {
                    this.sessionLifecycle.close({
                        sessionId: session.session_id,
                        reason: 'table_session_attach_failed',
                        source,
                    });
                }
                throw error;
            }
        }
        const refreshed = await this.getTable(normalized);
        this._emit('table_occupied', {
            table: refreshed, tableId: normalized, visitId, sessionId: session?.session_id || null,
            source, reason: 'continue_visit', previousStatus: table?.status || null,
        });
        return { table: refreshed, visit: await this.getVisit(normalized, visitId), session, continued: false };
    }

    async setGuestCount(tableId, visitId, guestCount) {
        const normalized = normalizeTable(tableId);
        const count = Number(guestCount);
        if (!Number.isInteger(count) || count < 1) throw serviceError('guest_count debe ser un entero positivo.', 'INVALID_GUEST_COUNT');
        const result = await this.pool.query(
            `UPDATE restaurant_visits SET guest_count = $1, version = version + 1, updated_at = NOW()
              WHERE table_id = $2 AND visit_id = $3 AND status = 'active' RETURNING *`,
            [count, normalized, visitId],
        );
        if (!result.rows[0]) throw serviceError('Visita activa no encontrada.', 'VISIT_NOT_FOUND');
        return this.getVisit(normalized, visitId);
    }

    async moveDraftOrder({ sessionId, orderId = null, targetTableId, source = 'robot_screen' } = {}) {
        const session = this.sessionLifecycle?.get?.(sessionId);
        if (!session) throw serviceError('Sesión no encontrada.', 'SESSION_NOT_FOUND');
        const sourceTableId = normalizeTable(session.mesa);
        const targetTable = normalizeTable(targetTableId);
        if (orderId && String(orderId) !== String(session.active_order_id || '')) {
            throw serviceError('El pedido no pertenece a la sesión activa.', 'ORDER_OWNERSHIP_MISMATCH');
        }
        const order = await this.pedidoRepo.findById(session.active_order_id);
        if (!order) return this.moveEmptyAttention({ sessionId, targetTableId: targetTable, source });
        if (sourceTableId === targetTable) {
            return { moved: false, order, table: await this.getTable(targetTable), visit: order.visit_id ? await this.getVisit(targetTable, order.visit_id) : null };
        }
        this._assertRobotCanMove(sessionId, targetTable);
        if (!['draft', 'pending_confirmation', 'provisional'].includes(order.status)
            || ['confirmed', 'completed'].includes(session.state)) {
            throw serviceError('El pedido ya está confirmado y no se puede mover.', 'TABLE_LOCKED');
        }
        const client = await this.pool.connect();
        let sourceVisit;
        let targetVisit;
        let sourceClosed = false;
        let sessionMove = null;
        try {
            await client.query('BEGIN');
            const lockIds = [sourceTableId, targetTable].sort();
            const lockedTables = new Map();
            for (const tableId of lockIds) {
                const tableResult = await client.query(
                    'SELECT * FROM restaurant_tables WHERE table_id = $1 FOR UPDATE',
                    [tableId],
                );
                if (!tableResult.rows[0]) throw serviceError(`Mesa ${tableId} no encontrada.`, 'TABLE_NOT_FOUND');
                lockedTables.set(tableId, tableResult.rows[0]);
            }
            const sourceRow = lockedTables.get(sourceTableId);
            const targetRow = lockedTables.get(targetTable);
            if (!targetRow.enabled || targetRow.current_visit_id) {
                throw serviceError(`La mesa ${targetTable} no está disponible.`, 'TABLE_OCCUPIED');
            }
            const sourceVisitResult = await client.query(
                `SELECT * FROM restaurant_visits
                   WHERE visit_id = $1 AND table_id = $2 AND status = 'active'
                   FOR UPDATE`,
                [session.visit_id || order.visit_id, sourceTableId],
            );
            sourceVisit = sourceVisitResult.rows[0];
            if (!sourceVisit || sourceRow.current_visit_id !== sourceVisit.visit_id || order.visit_id !== sourceVisit.visit_id) {
                throw serviceError('La visita del pedido ya no está activa.', 'STALE_VISIT');
            }
            const lockedOrderResult = await client.query(
                'SELECT id, status, visit_id FROM pedidos WHERE id = $1 FOR UPDATE',
                [order.id],
            );
            const lockedOrder = lockedOrderResult.rows[0];
            if (!lockedOrder || lockedOrder.visit_id !== sourceVisit.visit_id) {
                throw serviceError('El pedido ya no pertenece a la visita activa.', 'STALE_VISIT');
            }
            if (!['draft', 'pending_confirmation', 'provisional'].includes(lockedOrder.status)) {
                throw serviceError('El pedido ya está confirmado y no se puede mover.', 'TABLE_LOCKED');
            }
            const sourceSessionIds = uniqueStrings(parseJson(sourceVisit.session_ids)).filter(id => id !== String(sessionId));
            targetVisit = (await client.query(
                `INSERT INTO restaurant_visits (table_id, session_ids, order_ids, guest_count, notes)
                 VALUES ($1, $2::jsonb, $3::jsonb, $4, $5) RETURNING *`,
                [targetTable, JSON.stringify([sessionId]), JSON.stringify([String(order.id)]), session.guest_count || sourceVisit.guest_count || null, `Draft movido desde ${sourceTableId}`],
            )).rows[0];
            await client.query(
                `UPDATE pedidos
                    SET visit_id = $1, order_sequence = 1, order_kind = 'initial', table_id = $2, mesa = $2
                  WHERE id = $3`,
                [targetVisit.visit_id, targetTable, order.id],
            );
            const remainingOrdersResult = await client.query(
                'SELECT id, status FROM pedidos WHERE visit_id = $1 ORDER BY order_sequence ASC NULLS LAST',
                [sourceVisit.visit_id],
            );
            const remainingOrderIds = remainingOrdersResult.rows.map(row => String(row.id));
            if (remainingOrderIds.length === 0 && sourceSessionIds.length === 0) {
                sourceClosed = true;
                await client.query(
                    `UPDATE restaurant_visits
                        SET status = 'closed', closed_at = NOW(), close_reason = 'draft_table_move',
                            order_ids = '[]'::jsonb, session_ids = '[]'::jsonb,
                            version = version + 1, updated_at = NOW()
                      WHERE visit_id = $1`,
                    [sourceVisit.visit_id],
                );
                await client.query(
                    `UPDATE restaurant_tables
                        SET status = 'available', current_visit_id = NULL, active_session_id = NULL,
                            active_order_ids = '[]'::jsonb, opened_at = NULL,
                            version = version + 1, last_status_changed_at = NOW(), updated_at = NOW()
                      WHERE table_id = $1`,
                    [sourceTableId],
                );
            } else {
                const sourceStatus = await this._statusForVisit(client, sourceVisit.visit_id);
                const sourceActiveOrderIds = await this._activeOrderIdsForVisit(client, sourceVisit.visit_id);
                await client.query(
                    `UPDATE restaurant_visits
                        SET order_ids = $1::jsonb, session_ids = $2::jsonb,
                            version = version + 1, updated_at = NOW()
                      WHERE visit_id = $3`,
                    [JSON.stringify(remainingOrderIds), JSON.stringify(sourceSessionIds), sourceVisit.visit_id],
                );
                await client.query(
                    `UPDATE restaurant_tables
                        SET status = $1, active_session_id = $2, active_order_ids = $3::jsonb,
                            version = version + 1, updated_at = NOW()
                      WHERE table_id = $4`,
                    [sourceStatus, sourceSessionIds[0] || null, JSON.stringify(sourceActiveOrderIds), sourceTableId],
                );
            }
            await client.query(
                `UPDATE restaurant_tables
                    SET status = 'ordering', current_visit_id = $1, active_session_id = $2,
                        active_order_ids = $3::jsonb, opened_at = COALESCE(opened_at, NOW()),
                        version = version + 1, last_status_changed_at = NOW(), updated_at = NOW()
                  WHERE table_id = $4`,
                [targetVisit.visit_id, sessionId, JSON.stringify([String(order.id)]), targetTable],
            );
            sessionMove = this.sessionLifecycle.prepareTableMove(sessionId, {
                mesa: targetTable,
                visitId: targetVisit.visit_id,
                source,
            });
            sessionMove.apply();
            await this._recordAudit(client, {
                event: 'draft_order_moved', mesa: targetTable, sessionId, orderId: order.id, actor: 'system', source,
                previousState: { mesa: sourceTableId, visit_id: sourceVisit.visit_id },
                nextState: { mesa: targetTable, visit_id: targetVisit.visit_id },
                metadata: { source_table: sourceTableId, target_table: targetTable, source_visit_id: sourceVisit.visit_id, target_visit_id: targetVisit.visit_id },
            });
            await client.query('COMMIT');
        } catch (error) {
            sessionMove?.rollback();
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        sessionMove?.finalize();
        const movedOrder = await this.pedidoRepo.findById(order.id);
        const sourceSnapshot = await this.getTable(sourceTableId);
        const targetSnapshot = await this.getTable(targetTable);
        this._emit(sourceClosed ? 'table_available' : 'table_status_changed', {
            table: sourceSnapshot, tableId: sourceTableId, visitId: sourceVisit.visit_id, orderId: order.id,
            source, reason: 'draft_table_move', previousStatus: sourceClosed ? 'ordering' : null,
        });
        this._emit('draft_order_moved', {
            table: targetSnapshot, tableId: targetTable, visitId: targetVisit.visit_id, sessionId, orderId: order.id,
            source, reason: 'draft_table_move', previousStatus: 'ordering',
        });
        return {
            moved: true,
            order: movedOrder,
            table: targetSnapshot,
            visit: await this.getVisit(targetTable, targetVisit.visit_id),
            source_table: sourceSnapshot,
            source_visit_id: sourceVisit.visit_id,
        };
    }

    async moveEmptyAttention({ sessionId, targetTableId, source = 'robot_screen' } = {}) {
        const session = this.sessionLifecycle?.get?.(sessionId);
        if (!session) throw serviceError('Sesión no encontrada.', 'SESSION_NOT_FOUND');
        const sourceTableId = normalizeTable(session.mesa);
        const targetTable = normalizeTable(targetTableId);
        if (sourceTableId === targetTable) {
            return { moved: false, table: await this.getTable(targetTable), visit: session.visit_id ? await this.getVisit(targetTable, session.visit_id) : null };
        }
        this._assertRobotCanMove(sessionId, targetTable);
        const client = await this.pool.connect();
        let sourceVisit;
        let targetVisit;
        let sessionMove = null;
        try {
            await client.query('BEGIN');
            const lockIds = [sourceTableId, targetTable].sort();
            const lockedTables = new Map();
            for (const tableId of lockIds) {
                const tableResult = await client.query(
                    'SELECT * FROM restaurant_tables WHERE table_id = $1 FOR UPDATE',
                    [tableId],
                );
                if (!tableResult.rows[0]) throw serviceError(`Mesa ${tableId} no encontrada.`, 'TABLE_NOT_FOUND');
                lockedTables.set(tableId, tableResult.rows[0]);
            }
            const sourceRow = lockedTables.get(sourceTableId);
            const targetRow = lockedTables.get(targetTable);
            if (!targetRow.enabled || targetRow.current_visit_id) {
                throw serviceError(`La mesa ${targetTable} no está disponible.`, 'TABLE_OCCUPIED');
            }
            const sourceVisitResult = await client.query(
                `SELECT * FROM restaurant_visits
                   WHERE visit_id = $1 AND table_id = $2 AND status = 'active'
                   FOR UPDATE`,
                [session.visit_id, sourceTableId],
            );
            sourceVisit = sourceVisitResult.rows[0];
            if (!sourceVisit || sourceRow.current_visit_id !== sourceVisit.visit_id) {
                throw serviceError('La visita de la atención ya no está activa.', 'STALE_VISIT');
            }
            const sourceSessionIds = uniqueStrings(parseJson(sourceVisit.session_ids));
            if (!sourceSessionIds.includes(String(sessionId))) {
                throw serviceError('La sesión no pertenece a la visita activa.', 'STALE_VISIT');
            }
            if (sourceSessionIds.some(id => id !== String(sessionId))) {
                throw serviceError('La visita tiene otra atención activa y no puede moverse completa.', 'TABLE_LOCKED');
            }
            const orders = await client.query(
                'SELECT id, status FROM pedidos WHERE visit_id = $1 FOR UPDATE',
                [sourceVisit.visit_id],
            );
            if (orders.rows.length > 0) {
                throw serviceError('La mesa tiene pedidos asociados; usa el movimiento seguro del draft.', 'TABLE_LOCKED');
            }
            targetVisit = (await client.query(
                `INSERT INTO restaurant_visits (table_id, session_ids, guest_count, notes)
                 VALUES ($1, $2::jsonb, $3, $4) RETURNING *`,
                [targetTable, JSON.stringify([sessionId]), session.guest_count || sourceVisit.guest_count || null, `Atención movida desde ${sourceTableId}`],
            )).rows[0];
            await client.query(
                `UPDATE restaurant_visits
                    SET status = 'closed', closed_at = NOW(), close_reason = 'attention_table_move',
                        session_ids = '[]'::jsonb, version = version + 1, updated_at = NOW()
                  WHERE visit_id = $1`,
                [sourceVisit.visit_id],
            );
            await client.query(
                `UPDATE restaurant_tables
                    SET status = 'available', current_visit_id = NULL, active_session_id = NULL,
                        active_order_ids = '[]'::jsonb, opened_at = NULL,
                        version = version + 1, last_status_changed_at = NOW(), updated_at = NOW()
                  WHERE table_id = $1`,
                [sourceTableId],
            );
            await client.query(
                `UPDATE restaurant_tables
                    SET status = 'ordering', current_visit_id = $1, active_session_id = $2,
                        active_order_ids = '[]'::jsonb, opened_at = COALESCE(opened_at, NOW()),
                        version = version + 1, last_status_changed_at = NOW(), updated_at = NOW()
                  WHERE table_id = $3`,
                [targetVisit.visit_id, sessionId, targetTable],
            );
            sessionMove = this.sessionLifecycle.prepareTableMove(sessionId, {
                mesa: targetTable,
                visitId: targetVisit.visit_id,
                source,
            });
            sessionMove.apply();
            await this._recordAudit(client, {
                event: 'attention_table_moved', mesa: targetTable, sessionId, actor: 'system', source,
                previousState: { mesa: sourceTableId, visit_id: sourceVisit.visit_id },
                nextState: { mesa: targetTable, visit_id: targetVisit.visit_id },
                metadata: { source_table: sourceTableId, target_table: targetTable, source_visit_id: sourceVisit.visit_id, target_visit_id: targetVisit.visit_id },
            });
            await client.query('COMMIT');
        } catch (error) {
            sessionMove?.rollback();
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        sessionMove?.finalize();
        const sourceSnapshot = await this.getTable(sourceTableId);
        const targetSnapshot = await this.getTable(targetTable);
        this._emit('table_available', {
            table: sourceSnapshot, tableId: sourceTableId, visitId: sourceVisit.visit_id, source, reason: 'attention_table_move', previousStatus: 'ordering',
        });
        this._emit('attention_table_moved', {
            table: targetSnapshot, tableId: targetTable, visitId: targetVisit.visit_id, sessionId, source, reason: 'attention_table_move', previousStatus: 'available',
        });
        return {
            moved: true,
            table: targetSnapshot,
            visit: await this.getVisit(targetTable, targetVisit.visit_id),
            source_table: sourceSnapshot,
            source_visit_id: sourceVisit.visit_id,
        };
    }

    async setTableEnabled(tableId, enabled, { source = 'admin' } = {}) {
        const normalized = normalizeTable(tableId);
        if (typeof enabled !== 'boolean') throw serviceError('enabled debe ser booleano.', 'INVALID_ENABLED');
        const current = await this.getTable(normalized);
        const result = await this.pool.query(
            `UPDATE restaurant_tables
                SET enabled = $1, version = version + 1, updated_at = NOW(),
                    status = CASE WHEN $1 THEN CASE WHEN current_visit_id IS NULL THEN 'available' ELSE status END ELSE 'closed' END
              WHERE table_id = $2 AND ($1 OR current_visit_id IS NULL) RETURNING *`,
            [Boolean(enabled), normalized],
        );
        if (!result.rows[0]) {
            if (!current) throw serviceError('Mesa no encontrada.', 'TABLE_NOT_FOUND');
            if (!enabled && current.current_visit_id) {
                throw serviceError(`No se puede deshabilitar ${normalized} mientras tiene una visita activa.`, 'TABLE_ACTIVE');
            }
            throw serviceError('No se pudo actualizar la mesa por una transición concurrente.', 'TABLE_CONFLICT');
        }
        await this._recordAudit(null, {
            event: enabled ? 'table_enabled' : 'table_disabled', mesa: normalized, actor: 'admin', source,
            previousState: {}, nextState: { enabled: Boolean(enabled) }, metadata: {},
        });
        this._emit('table_status_changed', {
            table: await this.getTable(normalized), tableId: normalized,
            source, reason: enabled ? 'enabled' : 'disabled', previousStatus: current?.status || null,
        });
        return this.getTable(normalized);
    }

    async setTableDisplayName(tableId, displayName, { source = 'admin' } = {}) {
        const normalized = normalizeTable(tableId);
        const value = String(displayName || '').trim();
        if (!value || value.length > 20) throw serviceError('display_name inválido.', 'INVALID_DISPLAY_NAME');
        const result = await this.pool.query(
            `UPDATE restaurant_tables SET display_name = $1, version = version + 1, updated_at = NOW()
              WHERE table_id = $2 RETURNING *`,
            [value, normalized],
        );
        if (!result.rows[0]) throw serviceError('Mesa no encontrada.', 'TABLE_NOT_FOUND');
        await this._recordAudit(null, {
            event: 'table_status_changed', mesa: normalized, actor: 'admin', source,
            previousState: {}, nextState: { display_name: value }, metadata: { field: 'display_name' },
        });
        return this.getTable(normalized);
    }

    async closeVisit({ tableId, visitId, source = 'admin', reason = 'admin_closed', force = false, confirmation = false } = {}) {
        const normalized = normalizeTable(tableId);
        const effectiveReason = String(reason || '').trim() || 'admin_closed';
        const client = await this.pool.connect();
        let blocked = [];
        let table;
        let visit;
        let alreadyClosed = false;
        let forceCancelledOrderIds = [];
        try {
            await client.query('BEGIN');
            table = await this._lockTable(client, normalized);
            const visitResult = await client.query(
                `SELECT * FROM restaurant_visits WHERE table_id = $1 AND visit_id = $2 FOR UPDATE`,
                [normalized, visitId],
            );
            visit = visitResult.rows[0];
            if (!visit) throw serviceError('Visita activa no encontrada.', 'VISIT_NOT_FOUND');
            if (visit.status !== 'active') {
                alreadyClosed = true;
                await client.query('COMMIT');
            } else {
            if (force && effectiveReason === 'admin_closed') {
                throw serviceError('El cierre forzado requiere un motivo.', 'FORCE_REASON_REQUIRED');
            }
            const orders = await client.query(
                `SELECT id, status FROM pedidos WHERE visit_id = $1 ORDER BY order_sequence ASC NULLS LAST FOR UPDATE`,
                [visitId],
            );
            blocked = orders.rows.filter(order => BLOCKING_ORDER_STATUSES.has(order.status)).map(order => ({ id: order.id, status: order.status }));
            for (const sessionId of uniqueStrings(parseJson(visit.session_ids))) {
                const session = this.sessionLifecycle?.get?.(sessionId);
                if (session && !['closed', 'expired'].includes(session.session_status)) {
                    blocked.push({ session_id: sessionId, status: 'session_active' });
                }
            }
            if (this.waiterAssistanceService?.list) {
                const requests = await this.waiterAssistanceService.list({ status: 'pending' }).catch(() => []);
                requests
                    .filter(request => request.mesa === normalized
                        && request.visit_id === visitId
                        && uniqueStrings(parseJson(visit.session_ids)).includes(request.session_id))
                    .forEach(request => blocked.push({ request_id: request.request_id, status: 'waiter_assistance_pending' }));
            }
            await this._recordAudit(client, {
                event: 'table_close_requested', mesa: normalized, actor: 'admin', source,
                previousState: { status: table.status, visit_id: visitId },
                nextState: { status: force ? 'closed' : table.status },
                metadata: { reason: effectiveReason, force, confirmation, blocked },
            });
            if (blocked.length > 0 && !force) {
                await this._recordAudit(client, {
                    event: 'table_close_blocked', mesa: normalized, actor: 'admin', source,
                    previousState: { status: table.status, visit_id: visitId }, nextState: { status: table.status },
                    metadata: { reason: effectiveReason, blocked },
                });
                await client.query('COMMIT');
            } else {
                if (force && !confirmation) throw serviceError('El cierre forzado requiere confirmación explícita.', 'FORCE_CONFIRMATION_REQUIRED');
                if (force && blocked.length > 0) {
                    const blockingStatuses = [...BLOCKING_ORDER_STATUSES];
                    const cancelledOrders = await client.query(
                        `UPDATE pedidos
                            SET status = 'cancelled', estado = 'cancelado'
                          WHERE visit_id = $1 AND status = ANY($2::text[])
                          RETURNING id`,
                        [visitId, blockingStatuses],
                    );
                    forceCancelledOrderIds = cancelledOrders.rows.map(order => String(order.id));
                    for (const orderId of forceCancelledOrderIds) {
                        await this._recordAudit(client, {
                            event: 'order_force_cancelled', mesa: normalized, orderId,
                            actor: 'admin', source,
                            previousState: { status: 'pending', visit_id: visitId },
                            nextState: { status: 'cancelled', visit_id: visitId },
                            metadata: { reason: effectiveReason, force: true },
                        });
                    }
                }
                await client.query(
                    `UPDATE restaurant_visits
                        SET status = 'closed', closed_at = NOW(), close_reason = $1,
                            version = version + 1, updated_at = NOW()
                      WHERE visit_id = $2`,
                    [force ? `force:${effectiveReason}` : effectiveReason, visitId],
                );
                await client.query(
                    `UPDATE restaurant_tables
                        SET status = 'closed', current_visit_id = NULL, active_session_id = NULL,
                            active_order_ids = '[]'::jsonb, version = version + 1,
                            last_status_changed_at = NOW(), updated_at = NOW()
                      WHERE table_id = $1`,
                    [normalized],
                );
                await this._recordAudit(client, {
                    event: force ? 'table_force_closed' : 'visit_closed', mesa: normalized, actor: 'admin', source,
                    previousState: { status: table.status, visit_id: visitId }, nextState: { status: 'closed', visit_id: visitId },
                    metadata: { reason: effectiveReason, force, blocked, force_cancelled_order_ids: forceCancelledOrderIds },
                });
                await client.query(
                    `UPDATE restaurant_tables
                        SET status = 'available', opened_at = NULL, version = version + 1,
                            last_status_changed_at = NOW(), updated_at = NOW()
                      WHERE table_id = $1`,
                    [normalized],
                );
                await this._recordAudit(client, {
                    event: 'table_released', mesa: normalized, actor: 'admin', source,
                    previousState: { status: 'closed', visit_id: visitId }, nextState: { status: 'available' },
                    metadata: { reason: effectiveReason, force },
                });
                await client.query('COMMIT');
            }
            }
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        if (alreadyClosed) {
            return { blocked: false, alreadyClosed: true, table: await this.getTable(normalized), visit: await this.getVisit(normalized, visitId), visit_id: visitId };
        }
        if (blocked.length > 0 && !force) {
            const snapshot = await this.getTable(normalized);
            this._emit('table_close_blocked', {
                table: snapshot, tableId: normalized, visitId, source, reason: effectiveReason,
            });
            return { blocked: true, table: snapshot, visit_id: visitId, blockers: blocked };
        }
        for (const sessionId of uniqueStrings(parseJson(visit.session_ids))) {
            const session = this.sessionLifecycle?.get?.(sessionId);
            if (session && !['closed', 'expired'].includes(session.session_status)) {
                this.sessionLifecycle.close({ sessionId, reason: force ? 'table_force_closed' : effectiveReason, source });
            }
        }
        const snapshot = await this.getTable(normalized);
        this._emit(force ? 'table_force_closed' : 'table_visit_closed', {
            table: snapshot, tableId: normalized, visitId, source, reason: effectiveReason,
        });
        this._emit('table_available', { table: snapshot, tableId: normalized, visitId, source, reason: effectiveReason, previousStatus: 'closed' });
        return { blocked: false, table: snapshot, visit: await this.getVisit(normalized, visitId), visit_id: visitId };
    }

    async attachOrder({ order, session = null, source = 'order' } = {}) {
        if (!order?.id) throw new Error('order.id es obligatorio');
        const tableId = normalizeTable(order.table_id || order.mesa || session?.mesa);
        const requestedVisitId = order.visit_id || session?.visit_id || null;
        const client = await this.pool.connect();
        let visit;
        let sequence;
        let kind;
        try {
            await client.query('BEGIN');
            const table = await this._lockTable(client, tableId);
            if (!table.enabled) throw serviceError(`La mesa ${tableId} está deshabilitada.`, 'TABLE_DISABLED');
            const visitResult = requestedVisitId
                ? await client.query('SELECT * FROM restaurant_visits WHERE visit_id = $1 AND table_id = $2 AND status = \'active\' FOR UPDATE', [requestedVisitId, tableId])
                : await client.query('SELECT * FROM restaurant_visits WHERE table_id = $1 AND status = \'active\' ORDER BY opened_at ASC LIMIT 1 FOR UPDATE', [tableId]);
            visit = visitResult.rows[0];
            if (!visit && requestedVisitId) {
                throw serviceError(`La visita indicada para ${tableId} ya no está activa.`, 'STALE_VISIT', { visit_id: requestedVisitId });
            }
            if (!requestedVisitId && visit && !session?.visit_id && order.order_kind !== 'additional' && order.additional_order !== true) {
                throw serviceError(`La mesa ${tableId} ya tiene una atención activa. Usa el flujo explícito de pedido adicional.`, 'TABLE_OCCUPIED', { visit_id: visit.visit_id });
            }
            if (!visit) {
                const created = await client.query(
                    `INSERT INTO restaurant_visits (table_id, session_ids, notes)
                     VALUES ($1, $2::jsonb, 'Visita iniciada por pedido existente') RETURNING *`,
                    [tableId, JSON.stringify(session?.session_id ? [session.session_id] : [])],
                );
                visit = created.rows[0];
                await this._recordAudit(client, {
                    event: 'visit_started', mesa: tableId, sessionId: session?.session_id || order.session_id || null,
                    orderId: order.id, actor: 'system', source,
                    previousState: { status: table.status }, nextState: { status: 'ordering', visit_id: visit.visit_id },
                    metadata: { reason: 'order_link' },
                });
            }
            const existingOrder = await client.query(
                `SELECT visit_id, order_sequence, order_kind FROM pedidos WHERE id = $1 FOR UPDATE`,
                [order.id],
            );
            const existingLink = existingOrder.rows[0];
            const alreadyLinked = existingLink?.visit_id === visit.visit_id && Number(existingLink.order_sequence) > 0;
            sequence = alreadyLinked ? Number(existingLink.order_sequence) : null;
            kind = alreadyLinked ? existingLink.order_kind : null;
            if (!alreadyLinked) {
                const maxResult = await client.query(
                    'SELECT COALESCE(MAX(order_sequence), 0) AS max_sequence FROM pedidos WHERE visit_id = $1',
                    [visit.visit_id],
                );
                sequence = Number(maxResult.rows[0].max_sequence) + 1;
                kind = sequence === 1 ? 'initial' : 'additional';
                await client.query(
                    `UPDATE pedidos SET visit_id = $1, order_sequence = $2, order_kind = $3,
                            table_id = $4, mesa = $4
                      WHERE id = $5`,
                    [visit.visit_id, sequence, kind, tableId, order.id],
                );
            }
            const orderIds = uniqueStrings(parseJson(visit.order_ids));
            if (!orderIds.includes(String(order.id))) orderIds.push(String(order.id));
            const sessionIds = uniqueStrings(parseJson(visit.session_ids));
            if (session?.session_id && !sessionIds.includes(session.session_id)) sessionIds.push(session.session_id);
            await client.query(
                `UPDATE restaurant_visits
                    SET order_ids = $1::jsonb, session_ids = $2::jsonb,
                        version = version + 1, updated_at = NOW()
                  WHERE visit_id = $3`,
                [JSON.stringify(orderIds), JSON.stringify(sessionIds), visit.visit_id],
            );
            const status = await this._statusForVisit(client, visit.visit_id, order.status);
            const activeOrderIds = await this._activeOrderIdsForVisit(client, visit.visit_id);
            await client.query(
                `UPDATE restaurant_tables
                    SET current_visit_id = $1, active_order_ids = $2::jsonb,
                        status = $3, active_session_id = COALESCE(active_session_id, $4),
                        version = version + 1, last_status_changed_at = NOW(), updated_at = NOW()
                  WHERE table_id = $5`,
                [visit.visit_id, JSON.stringify(activeOrderIds), status, session?.session_id || order.session_id || null, tableId],
            );
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        if (session && visit?.visit_id) {
            session.visit_id = visit.visit_id;
            this.sessionLifecycle?.notifyRobotVisitAttached?.(session.session_id, visit.visit_id);
        }
        const linkedOrder = await this.pedidoRepo.findById(order.id);
        const snapshot = await this.getTable(tableId);
        this._emit(kind === 'additional' ? 'additional_order_started' : 'table_status_changed', {
            table: snapshot, tableId, visitId: linkedOrder?.visit_id || order.visit_id,
            sessionId: session?.session_id || order.session_id || null, orderId: order.id,
            source, reason: kind === 'additional' ? 'additional_order_linked' : 'initial_order_linked', previousStatus: null,
        });
        return linkedOrder || { ...order, visit_id: visit?.visit_id, order_sequence: sequence, order_kind: kind };
    }

    async syncOrderStatus({ order = null, orderId = null, status = null, source = 'order_status' } = {}) {
        let target = order;
        if (!target && orderId) target = await this.pedidoRepo.findById(orderId);
        if (!target) return null;
        const nextStatus = status || target.status;
        const tableId = normalizeTable(target.table_id || target.mesa);
        if (!target.visit_id) target = await this.attachOrder({ order: target, source });
        const visitId = target.visit_id;
        const client = await this.pool.connect();
        let previousStatus = null;
        let nextTableStatus = null;
        let previousActiveOrderIds = [];
        let nextActiveOrderIds = [];
        let staleVisit = false;
        try {
            await client.query('BEGIN');
            const table = await this._lockTable(client, tableId);
            previousStatus = table.status;
            previousActiveOrderIds = uniqueStrings(parseJson(table.active_order_ids));
            const visitResult = await client.query('SELECT * FROM restaurant_visits WHERE visit_id = $1 FOR UPDATE', [visitId]);
            staleVisit = !visitResult.rows[0]
                || visitResult.rows[0].status !== 'active'
                || table.current_visit_id !== visitId;
            if (!staleVisit) {
                nextTableStatus = await this._statusForVisit(client, visitId, nextStatus);
                nextActiveOrderIds = await this._activeOrderIdsForVisit(client, visitId);
                await client.query(
                    `UPDATE restaurant_tables
                        SET status = $1, active_order_ids = $2::jsonb,
                            version = version + 1, last_status_changed_at = NOW(), updated_at = NOW()
                      WHERE table_id = $3`,
                    [nextTableStatus, JSON.stringify(nextActiveOrderIds), tableId],
                );
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        if (staleVisit) {
            const snapshot = await this.getTable(tableId);
            await this._recordAudit(null, {
                event: 'stale_order_status_rejected', mesa: tableId, orderId: target.id,
                actor: 'system', source,
                previousState: { status: previousStatus, active_order_ids: previousActiveOrderIds },
                nextState: { ignored: true, visit_id: visitId },
                metadata: { requested_status: nextStatus },
            });
            this._emit('stale_order_status_rejected', {
                table: snapshot, tableId, visitId, orderId: target.id,
                source, reason: 'inactive_or_non_current_visit', previousStatus,
            });
            return target;
        }
        const snapshot = await this.getTable(tableId);
        const activeOrderIdsChanged = JSON.stringify(previousActiveOrderIds) !== JSON.stringify(nextActiveOrderIds);
        if (previousStatus !== nextTableStatus || activeOrderIdsChanged) {
            const eventType = nextTableStatus === 'order_confirmed' ? 'table_order_confirmed'
                : nextTableStatus === 'preparing' ? 'table_preparing'
                    : nextTableStatus === 'ready' ? 'table_ready'
                        : nextTableStatus === 'served' ? 'table_served'
                            : 'table_status_changed';
            await this._recordAudit(null, {
                event: eventType, mesa: tableId, sessionId: target.session_id || null, orderId: target.id,
                actor: 'system', source,
                previousState: { status: previousStatus, active_order_ids: previousActiveOrderIds },
                nextState: { status: nextTableStatus, active_order_ids: nextActiveOrderIds, visit_id: visitId },
                metadata: { version: snapshot?.version || null },
            });
            this._emit(eventType, {
                table: snapshot, tableId, visitId, sessionId: target.session_id || null, orderId: target.id,
                source, reason: `order_${nextStatus}`, previousStatus,
            });
        }
        if (nextStatus === 'delivered' && this.autoReleaseAfterDelivery) {
            await this.closeVisit({ tableId, visitId, source: 'auto_release', reason: 'delivery_completed', force: false });
        }
        return target;
    }

    async syncVisit({ tableId, visitId, source = 'visit_sync' } = {}) {
        const normalized = normalizeTable(tableId);
        const client = await this.pool.connect();
        let previousStatus = null;
        let nextStatus = null;
        let previousActiveOrderIds = [];
        let nextActiveOrderIds = [];
        let skipSync = false;
        try {
            await client.query('BEGIN');
            const table = await this._lockTable(client, normalized);
            previousStatus = table.status;
            previousActiveOrderIds = uniqueStrings(parseJson(table.active_order_ids));
            const visit = await client.query('SELECT status FROM restaurant_visits WHERE table_id = $1 AND visit_id = $2 FOR UPDATE', [normalized, visitId]);
            if (!visit.rows[0]) {
                await client.query('COMMIT');
                return null;
            }
            skipSync = visit.rows[0].status !== 'active';
            if (!skipSync) {
                nextStatus = await this._statusForVisit(client, visitId);
                nextActiveOrderIds = await this._activeOrderIdsForVisit(client, visitId);
                await client.query(
                    `UPDATE restaurant_tables
                        SET status = $1, active_order_ids = $2::jsonb, version = version + 1,
                            last_status_changed_at = NOW(), updated_at = NOW()
                      WHERE table_id = $3`,
                    [nextStatus, JSON.stringify(nextActiveOrderIds), normalized],
                );
            }
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        if (skipSync) return this.getTable(normalized);
        const snapshot = await this.getTable(normalized);
        const changed = previousStatus !== nextStatus || JSON.stringify(previousActiveOrderIds) !== JSON.stringify(nextActiveOrderIds);
        if (changed) {
            await this._recordAudit(null, {
                event: 'table_status_changed', mesa: normalized, actor: 'system', source,
                previousState: { status: previousStatus, active_order_ids: previousActiveOrderIds },
                nextState: { status: nextStatus, active_order_ids: nextActiveOrderIds, visit_id: visitId },
                metadata: { reason: 'visit_sync', version: snapshot?.version || null },
            });
            this._emit('table_status_changed', {
                table: snapshot, tableId: normalized, visitId, source, reason: 'visit_sync', previousStatus,
            });
        }
        return snapshot;
    }

    async handleDeliveryStateChange(snapshot = {}) {
        const state = snapshot.state;
        const tableId = snapshot.mesa || snapshot.table_id;
        const orderId = snapshot.order_id || snapshot.orderId;
        if (!tableId || !orderId) return null;
        const normalized = normalizeTable(tableId);
        if (!['going_to_kitchen', 'picking_up', 'going_to_table', 'delivering', 'delivered'].includes(state)) return null;
        const table = await this.getTable(normalized);
        const order = await this.pedidoRepo.findById(orderId);
        const eventVisitId = snapshot.visit_id || snapshot.visitId || order?.visit_id || null;
        const currentVisitId = table?.current_visit_id || null;
        const orderBelongsToCurrentVisit = Boolean(
            table
            && currentVisitId
            && order
            && order.visit_id === currentVisitId
            && (!eventVisitId || eventVisitId === currentVisitId)
            && table.active_order_ids.includes(String(orderId)),
        );
        if (!orderBelongsToCurrentVisit) {
            await this._recordAudit(null, {
                event: 'stale_delivery_event_rejected', mesa: normalized, orderId,
                actor: 'system', source: snapshot.origin || 'ros2_simulation',
                previousState: { table_status: table?.status || null, current_visit_id: currentVisitId },
                nextState: { ignored: true },
                metadata: { event_state: state, event_visit_id: eventVisitId, order_visit_id: order?.visit_id || null },
            });
            this._emit('delivery_event_rejected', {
                table, tableId: normalized, visitId: eventVisitId, orderId,
                source: snapshot.origin || 'ros2_simulation', reason: 'stale_visit_or_order',
                previousStatus: table?.status || null,
            });
            return null;
        }
        if (state === 'delivered') return this.syncOrderStatus({ order, orderId, status: 'delivered', source: snapshot.origin || 'ros2_simulation' });
        return this._setTableStatus(normalized, 'delivery_in_progress', {
            visitId: currentVisitId, orderId, source: snapshot.origin || 'ros2_simulation', reason: state,
        });
    }

    async detachSession(sessionId, { source = 'session_closed' } = {}) {
        if (!sessionId) return [];
        const result = await this.pool.query(
            `UPDATE restaurant_tables
                SET active_session_id = NULL, version = version + 1, updated_at = NOW()
              WHERE active_session_id = $1
              RETURNING table_id, status, current_visit_id, version`,
            [sessionId],
        );
        const snapshots = [];
        for (const row of result.rows) {
            const snapshot = await this.getTable(row.table_id);
            snapshots.push(snapshot);
            await this._recordAudit(null, {
                event: 'session_detached_from_table', mesa: row.table_id, sessionId,
                actor: 'system', source,
                previousState: { status: row.status, active_session_id: sessionId },
                nextState: { status: row.status, active_session_id: null, visit_id: row.current_visit_id },
                metadata: { version: row.version },
            });
            this._emit('table_status_changed', {
                table: snapshot, tableId: row.table_id, visitId: row.current_visit_id,
                sessionId: null, source, reason: 'session_closed', previousStatus: row.status,
            });
        }
        return snapshots;
    }

    async setAutoReleaseAfterDelivery(enabled, { source = 'admin' } = {}) {
        this.autoReleaseAfterDelivery = Boolean(enabled);
        await this._recordAudit(null, {
            event: 'table_status_changed', actor: 'admin', source,
            previousState: { auto_release_after_delivery: !this.autoReleaseAfterDelivery },
            nextState: { auto_release_after_delivery: this.autoReleaseAfterDelivery }, metadata: { config: true },
        });
        return { auto_release_after_delivery: this.autoReleaseAfterDelivery };
    }

    async getConfig() {
        return { auto_release_after_delivery: this.autoReleaseAfterDelivery, table_ids: TABLE_IDS };
    }

    async _setTableStatus(tableId, status, { visitId = null, sessionId = null, orderId = null, source = 'system', reason = null } = {}) {
        const normalized = normalizeTable(tableId);
        const current = await this.getTable(normalized);
        const result = await this.pool.query(
            `UPDATE restaurant_tables
                SET status = $1, current_visit_id = COALESCE($2, current_visit_id),
                    active_session_id = COALESCE($3, active_session_id),
                    version = version + 1, last_status_changed_at = NOW(), updated_at = NOW()
              WHERE table_id = $4
                AND ($2::uuid IS NULL OR current_visit_id = $2::uuid)
                AND version = $5
              RETURNING *`,
            [status, visitId, sessionId, normalized, current?.version || 0],
        );
        if (!result.rows[0]) {
            const latest = await this.getTable(normalized);
            if (!latest) throw serviceError('Mesa no encontrada.', 'TABLE_NOT_FOUND');
            await this._recordAudit(null, {
                event: 'stale_table_status_rejected', mesa: normalized, sessionId, orderId,
                actor: 'system', source,
                previousState: { status: current?.status || null, visit_id: current?.current_visit_id || null, version: current?.version || null },
                nextState: { ignored: true, status, visit_id: visitId, version: latest.version },
                metadata: { reason: 'visit_or_version_conflict', transition_reason: reason },
            });
            this._emit('delivery_event_rejected', {
                table: latest, tableId: normalized, visitId, sessionId, orderId, source,
                reason: 'visit_or_version_conflict', previousStatus: latest.status,
            });
            return latest;
        }
        const table = await this.getTable(normalized);
        await this._recordAudit(null, {
            event: status === 'delivery_in_progress' ? 'table_delivery_started' : 'table_status_changed',
            mesa: normalized, sessionId, orderId, actor: 'system', source,
            previousState: { status: current?.status || null }, nextState: { status, visit_id: visitId }, metadata: { reason },
        });
        this._emit(status === 'delivery_in_progress' ? 'table_delivery_started' : 'table_status_changed', {
            table, tableId: normalized, visitId, sessionId, orderId, source, reason, previousStatus: current?.status || null,
        });
        return table;
    }

    async _statusForVisit(client, visitId, incomingStatus = null) {
        const result = await client.query('SELECT status FROM pedidos WHERE visit_id = $1', [visitId]);
        const statuses = result.rows.map(row => row.status);
        if (incomingStatus && !statuses.includes(incomingStatus)) statuses.push(incomingStatus);
        for (const [orderStatus, tableStatus] of STATUS_PRIORITY) {
            if (statuses.includes(orderStatus)) return tableStatus;
        }
        if (statuses.length > 0 && statuses.every(status => status === 'delivered')) return 'served';
        return 'ordering';
    }

    async _activeOrderIdsForVisit(client, visitId) {
        const result = await client.query('SELECT id, status FROM pedidos WHERE visit_id = $1 AND archived_at IS NULL AND deleted_at IS NULL', [visitId]);
        return result.rows
            .filter(row => !['delivered', 'cancelled'].includes(row.status))
            .map(row => String(row.id));
    }

    async _lockTable(client, tableId) {
        await client.query(
            `INSERT INTO restaurant_tables (table_id, display_name)
             VALUES ($1, $2) ON CONFLICT (table_id) DO NOTHING`,
            [tableId, `Mesa ${tableId}`],
        );
        const result = await client.query('SELECT * FROM restaurant_tables WHERE table_id = $1 FOR UPDATE', [tableId]);
        if (!result.rows[0]) throw serviceError('Mesa no encontrada.', 'TABLE_NOT_FOUND');
        return result.rows[0];
    }

    async _attachSession(visitId, tableId, sessionId, source, additional) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const tableResult = await client.query(
                `SELECT current_visit_id
                   FROM restaurant_tables
                  WHERE table_id = $1
                  FOR UPDATE`,
                [tableId],
            );
            if (!tableResult.rows[0] || tableResult.rows[0].current_visit_id !== visitId) {
                throw serviceError('La mesa cambió de visita antes de asociar la sesión.', 'STALE_VISIT', { visit_id: visitId });
            }
            const visitResult = await client.query(
                `SELECT session_ids
                   FROM restaurant_visits
                  WHERE visit_id = $1 AND table_id = $2 AND status = 'active'
                  FOR UPDATE`,
                [visitId, tableId],
            );
            if (!visitResult.rows[0]) {
                throw serviceError('La visita indicada ya no está activa.', 'STALE_VISIT', { visit_id: visitId });
            }
            const sessionIds = uniqueStrings(parseJson(visitResult.rows[0].session_ids));
            if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId);
            await client.query(
                `UPDATE restaurant_visits SET session_ids = $1::jsonb, version = version + 1, updated_at = NOW()
                  WHERE visit_id = $2`,
                [JSON.stringify(sessionIds), visitId],
            );
            const tableUpdate = await client.query(
                `UPDATE restaurant_tables SET active_session_id = $1, status = CASE WHEN status = 'available' THEN 'ordering' ELSE status END,
                    version = version + 1, updated_at = NOW()
                  WHERE table_id = $2 AND current_visit_id = $3::uuid
                  RETURNING table_id`,
                [sessionId, tableId, visitId],
            );
            if (!tableUpdate.rows[0]) {
                throw serviceError('La mesa cambió de visita antes de asociar la sesión.', 'STALE_VISIT', { visit_id: visitId });
            }
            await this._recordAudit(client, {
                event: additional ? 'additional_order_started' : 'initial_order_started',
                mesa: tableId, sessionId, actor: 'system', source,
                previousState: {}, nextState: { visit_id: visitId, active_session_id: sessionId }, metadata: {},
            });
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async _rollbackVisitWithoutOrders(visitId, tableId, source) {
        const result = await this.pool.query(
            `DELETE FROM restaurant_visits WHERE visit_id = $1 AND NOT EXISTS (SELECT 1 FROM pedidos WHERE visit_id = $1)`,
            [visitId],
        );
        if (result.rowCount > 0) {
            await this.pool.query(
                `UPDATE restaurant_tables SET current_visit_id = NULL, active_session_id = NULL, active_order_ids = '[]'::jsonb,
                    status = 'available', version = version + 1, updated_at = NOW()
                  WHERE table_id = $1 AND current_visit_id = $2::uuid`,
                [tableId, visitId],
            );
            await this._recordAudit(null, {
                event: 'visit_closed', mesa: tableId, actor: 'system', source,
                previousState: { visit_id: visitId }, nextState: { status: 'available' }, metadata: { reason: 'session_start_failed' },
            });
        }
    }

    async _recordAudit(client, {
        event, sessionId = null, orderId = null, itemId = null, productId = null, mesa = null,
        actor = 'system', source = 'fase8_tables', previousState = {}, nextState = {}, metadata = {},
    } = {}) {
        const target = client || this.pool;
        await target.query(
            `INSERT INTO pedido_eventos
                (event, session_id, order_id, item_id, product_id, mesa, actor, previous_state, next_state, source, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb)`,
            [event, sessionId, orderId, itemId, productId, mesa, actor, JSON.stringify(previousState), JSON.stringify(nextState), source, JSON.stringify(metadata)],
        );
    }

    _emit(type, { table = null, tableId = null, visitId = null, sessionId = null, orderId = null, source = 'fase8_tables', reason = null, previousStatus = null } = {}) {
        if (!this.sendToUI) return;
        const payload = {
            type,
            table_id: tableId || table?.table_id || null,
            visit_id: visitId || table?.current_visit_id || null,
            session_id: sessionId || table?.active_session_id || null,
            order_id: orderId || null,
            previous_status: previousStatus,
            current_status: table?.status || null,
            source,
            timestamp: new Date().toISOString(),
            reason,
            version: table?.version || 0,
            table,
        };
        try { this.sendToUI(payload); } catch (error) { this.logger.warn?.('[FASE8] Error emitiendo evento de mesa:', error.message); }
    }
}

export { TABLE_IDS, BLOCKING_ORDER_STATUSES, normalizeTable, asTableDto, asVisitDto };
