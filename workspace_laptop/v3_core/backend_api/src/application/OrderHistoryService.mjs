import { createHash, randomUUID } from 'node:crypto';

const ACTIVE_STATUSES = Object.freeze([
    'draft',
    'sent_to_kitchen',
    'confirmed',
    'preparing',
    'ready',
    'delivery_in_progress',
]);
const HISTORICAL_STATUSES = Object.freeze(['delivered', 'cancelled', 'closed']);
const STATUS_ALIASES = Object.freeze({
    provisional: 'draft',
    confirmado: 'confirmed',
    en_preparacion: 'preparing',
    listo: 'ready',
    entregado: 'delivered',
    cancelado: 'cancelled',
});
const SORTS = Object.freeze({
    newest: 'p.created_at DESC NULLS LAST, p.id DESC',
    oldest: 'p.created_at ASC NULLS LAST, p.id ASC',
    total: 'p.total DESC NULLS LAST, p.created_at DESC NULLS LAST, p.id DESC',
    table: 'p.table_id ASC NULLS LAST, p.created_at DESC NULLS LAST, p.id DESC',
    status: 'p.status ASC, p.created_at DESC NULLS LAST, p.id DESC',
    confirmed: 'p.confirmed_at DESC NULLS LAST, p.created_at DESC NULLS LAST, p.id DESC',
    delivered: 'p.delivered_at DESC NULLS LAST, p.created_at DESC NULLS LAST, p.id DESC',
});
const DATA_ORIGINS = new Set(['customer_order', 'admin_created', 'automated_test', 'manual_test', 'seed', 'migration', 'imported']);
const DEFAULT_POLICY = Object.freeze({
    draft_hours: 24,
    test_hours: 24,
    delivered_days: 30,
    cancelled_days: 7,
    audit_days: 3650,
    auto_delete_historical: false,
});
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 5000;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAINTENANCE_LOCK_KEY = 20711011;

export class OrderHistoryError extends Error {
    constructor(message, code, status = 400, details = undefined) {
        super(message);
        this.name = 'OrderHistoryError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function first(value) {
    return Array.isArray(value) ? value[0] : value;
}

function parseBoolean(value, field) {
    if (value === undefined || value === null || value === '') return null;
    const normalized = String(first(value)).trim().toLowerCase();
    if (['true', '1', 'yes', 'si'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
    throw new OrderHistoryError(`${field} debe ser booleano.`, 'INVALID_HISTORY_FILTER');
}

function normalizeTable(value) {
    if (value === undefined || value === null || value === '') return null;
    const raw = String(first(value)).trim().toUpperCase().replace(/^MESA\s*/, '').replace(/^M(?=\d)/, '');
    if (!/^([1-9]|1[0-2])$/.test(raw)) {
        throw new OrderHistoryError('La mesa debe estar entre M1 y M12.', 'INVALID_TABLE', 400);
    }
    return `M${Number(raw)}`;
}

function assertUuid(value, field = 'id') {
    const normalized = String(value || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(normalized)) {
        throw new OrderHistoryError(`${field} no es válido.`, 'INVALID_ORDER_ID', 400);
    }
    return normalized;
}

function parseNumeric(value, field, { integer = false, min = null, max = null } = {}) {
    if (value === undefined || value === null || value === '') return null;
    const raw = String(first(value)).trim();
    if (integer && !/^[+-]?\d+$/u.test(raw)) {
        throw new OrderHistoryError(`${field} no es válido.`, 'INVALID_HISTORY_FILTER');
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed)) || (min !== null && parsed < min) || (max !== null && parsed > max)) {
        throw new OrderHistoryError(`${field} no es válido.`, 'INVALID_HISTORY_FILTER');
    }
    return parsed;
}

function parseDate(value, field, { endExclusive = false } = {}) {
    if (value === undefined || value === null || value === '') return null;
    const raw = String(first(value)).trim();
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(raw);
    const date = new Date(dateOnly ? `${raw}T00:00:00.000Z` : raw);
    if (Number.isNaN(date.getTime())) throw new OrderHistoryError(`${field} no es una fecha válida.`, 'INVALID_DATE_FILTER');
    if (endExclusive && dateOnly) date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
}

function utcDayStart(date) {
    const value = new Date(date);
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function presetDates(value, now = new Date()) {
    const preset = String(first(value) || '').trim().toLowerCase();
    if (!preset) return { dateFrom: null, dateTo: null };
    const start = utcDayStart(now);
    if (preset === 'today' || preset === 'hoy') return { dateFrom: start.toISOString(), dateTo: new Date(start.getTime() + 86400000).toISOString() };
    if (preset === 'yesterday' || preset === 'ayer') {
        const previous = new Date(start.getTime() - 86400000);
        return { dateFrom: previous.toISOString(), dateTo: start.toISOString() };
    }
    if (preset === 'last7' || preset === 'last_7_days' || preset === 'ultimos_7_dias') {
        return { dateFrom: new Date(now.getTime() - 7 * 86400000).toISOString(), dateTo: now.toISOString() };
    }
    if (preset === 'current_month' || preset === 'mes_actual') {
        const month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
        const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
        return { dateFrom: month.toISOString(), dateTo: next.toISOString() };
    }
    if (preset === 'current_year' || preset === 'ano_actual' || preset === 'año_actual') {
        const year = new Date(Date.UTC(start.getUTCFullYear(), 0, 1));
        const next = new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1));
        return { dateFrom: year.toISOString(), dateTo: next.toISOString() };
    }
    throw new OrderHistoryError('El período de fecha no está soportado.', 'INVALID_DATE_PRESET');
}

function normalizeStatus(value) {
    if (value === undefined || value === null || value === '') return [];
    const values = String(first(value)).split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    const statuses = values.map(item => STATUS_ALIASES[item] || item);
    if (statuses.some(status => ![...ACTIVE_STATUSES, ...HISTORICAL_STATUSES].includes(status))) {
        throw new OrderHistoryError('El estado de pedido no está soportado.', 'INVALID_STATUS_FILTER');
    }
    return [...new Set(statuses)];
}

export function normalizeHistoryQuery(input = {}, { now = new Date() } = {}) {
    const page = parseNumeric(first(input.page) ?? 1, 'page', { integer: true, min: 1, max: 1_000_000 });
    const pageSize = parseNumeric(first(input.page_size ?? input.pageSize) ?? DEFAULT_PAGE_SIZE, 'page_size', { integer: true, min: 1, max: MAX_PAGE_SIZE });
    const sort = String(first(input.sort || input.order || 'newest')).trim().toLowerCase();
    if (!SORTS[sort]) throw new OrderHistoryError('El orden solicitado no está permitido.', 'INVALID_SORT');

    const view = String(first(input.view || input.scope || 'active')).trim().toLowerCase();
    if (!['active', 'history', 'historical', 'archived', 'test', 'all'].includes(view)) {
        throw new OrderHistoryError('La vista histórica no está soportada.', 'INVALID_HISTORY_VIEW');
    }
    const preset = first(input.date_preset || input.period || input.periodo);
    const presetRange = presetDates(preset, now);
    const dateFrom = parseDate(input.date_from ?? input.from, 'date_from') || presetRange.dateFrom;
    const dateTo = parseDate(input.date_to ?? input.to, 'date_to', { endExclusive: true }) || presetRange.dateTo;
    if (dateFrom && dateTo && new Date(dateFrom) >= new Date(dateTo)) {
        throw new OrderHistoryError('date_from debe ser anterior a date_to.', 'INVALID_DATE_RANGE');
    }
    const searchRaw = first(input.search ?? input.q ?? '');
    const search = String(searchRaw || '').trim().slice(0, 120);
    const productRaw = first(input.product || input.producto || '');
    const product = String(productRaw || '').trim().slice(0, 120);
    const orderKind = first(input.order_kind || input.kind);
    if (orderKind && !['initial', 'additional'].includes(String(orderKind))) {
        throw new OrderHistoryError('order_kind debe ser initial o additional.', 'INVALID_ORDER_KIND');
    }
    const archived = parseBoolean(input.archived, 'archived');
    const isTest = parseBoolean(input.is_test ?? input.test, 'is_test');
    const minTotal = parseNumeric(input.total_min ?? input.min_total, 'total_min', { min: 0 });
    const maxTotal = parseNumeric(input.total_max ?? input.max_total, 'total_max', { min: 0 });
    if (minTotal !== null && maxTotal !== null && minTotal > maxTotal) {
        throw new OrderHistoryError('total_min no puede superar total_max.', 'INVALID_TOTAL_RANGE');
    }
    return {
        page,
        page_size: pageSize,
        sort,
        view: view === 'historical' ? 'history' : view,
        statuses: normalizeStatus(input.status),
        table: normalizeTable(input.table || input.mesa),
        visit_id: first(input.visit_id || input.visit) ? String(first(input.visit_id || input.visit)).trim().slice(0, 80) : null,
        session_id: first(input.session_id || input.session) ? String(first(input.session_id || input.session)).trim().slice(0, 160) : null,
        order_kind: orderKind ? String(orderKind) : null,
        archived,
        is_test: isTest,
        search,
        product,
        total_min: minTotal,
        total_max: maxTotal,
        date_from: dateFrom,
        date_to: dateTo,
    };
}

export function buildHistoryWhere(query, { includeDeleted = false } = {}) {
    const clauses = [];
    const values = [];
    const add = (clause, value) => {
        values.push(value);
        clauses.push(clause.replace('?', `$${values.length}`));
    };
    if (!includeDeleted) clauses.push('p.deleted_at IS NULL');

    if (query.view === 'active') {
        clauses.push('p.archived_at IS NULL');
        clauses.push('(p.visit_id IS NULL OR v.status = \'active\')');
        add('p.status = ANY(?::text[])', ACTIVE_STATUSES);
    } else if (query.view === 'history') {
        clauses.push('p.archived_at IS NULL');
        add('p.status = ANY(?::text[])', HISTORICAL_STATUSES);
    } else if (query.view === 'archived') {
        clauses.push('p.archived_at IS NOT NULL');
    } else if (query.view === 'test') {
        clauses.push('p.is_test = true');
    } else if (query.view !== 'all' && query.archived !== true) {
        clauses.push('p.archived_at IS NULL');
    }
    if (query.archived === true) clauses.push('p.archived_at IS NOT NULL');
    if (query.archived === false) clauses.push('p.archived_at IS NULL');
    if (query.is_test !== null) add('p.is_test = ?', query.is_test);
    if (query.statuses.length) add('p.status = ANY(?::text[])', query.statuses);
    if (query.table) add('p.table_id = ?', query.table);
    if (query.visit_id) add('p.visit_id::text = ?', query.visit_id);
    if (query.session_id) add('p.session_id = ?', query.session_id);
    if (query.order_kind) add('p.order_kind = ?', query.order_kind);
    if (query.date_from) add('p.created_at >= ?', query.date_from);
    if (query.date_to) add('p.created_at < ?', query.date_to);
    if (query.total_min !== null) add('p.total >= ?', query.total_min);
    if (query.total_max !== null) add('p.total <= ?', query.total_max);
    if (query.product) {
        add("translate(lower(COALESCE(p.items, p.platos, '[]'::jsonb)::text), 'áéíóúüñ', 'aeiouun') ILIKE ?", `%${foldSearch(query.product)}%`);
    }
    if (query.search) {
        const like = `%${query.search}%`;
        const foldedLike = `%${foldSearch(query.search)}%`;
        values.push(like, foldedLike);
        const literalPlaceholder = `$${values.length - 1}`;
        const foldedPlaceholder = `$${values.length}`;
        clauses.push(`(p.id::text ILIKE ${literalPlaceholder} OR p.table_id ILIKE ${literalPlaceholder} OR p.visit_id::text ILIKE ${literalPlaceholder}
            OR p.session_id ILIKE ${literalPlaceholder} OR p.status ILIKE ${literalPlaceholder}
            OR translate(lower(COALESCE(p.notes, '')), 'áéíóúüñ', 'aeiouun') ILIKE ${foldedPlaceholder}
            OR translate(lower(COALESCE(p.items, p.platos, '[]'::jsonb)::text), 'áéíóúüñ', 'aeiouun') ILIKE ${foldedPlaceholder})`);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function parseJson(value, fallback = []) {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function foldSearch(value) {
    return String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function itemsFromRow(row) {
    const value = parseJson(row.items ?? row.platos, []);
    return Array.isArray(value) ? value : [];
}

function classifyRow(row) {
    const status = STATUS_ALIASES[row.status] || row.status || 'draft';
    const archived = Boolean(row.archived_at);
    const isTest = Boolean(row.is_test);
    const visitClosed = Boolean(row.visit_id) && row.visit_status === 'closed';
    const hasActiveReference = Boolean(row.session_id) || row.visit_status === 'active' || Boolean(row.requires_human);
    const active = ACTIVE_STATUSES.includes(status) && !archived;
    const historical = HISTORICAL_STATUSES.includes(status);
    const archiveAllowed = !archived && historical && visitClosed && status !== 'delivery_in_progress';
    const deleteAllowed = (isTest || status === 'draft')
        && !['sent_to_kitchen', 'confirmed', 'preparing', 'ready', 'delivery_in_progress'].includes(status)
        && !hasActiveReference;
    const classes = [];
    if (active) classes.push('active');
    if (historical) classes.push('historical');
    if (archived) classes.push('archived');
    if (isTest) classes.push('test');
    if (archiveAllowed) classes.push('archiveable');
    if (deleteAllowed) classes.push('deletable');
    if (!archiveAllowed && !deleteAllowed) classes.push('protected');
    return {
        classification: classes,
        can_archive: archiveAllowed,
        can_delete: deleteAllowed,
        visit_closed: visitClosed,
        protected_reason: archiveAllowed || deleteAllowed
            ? null
            : (row.visit_status === 'active' ? 'active_visit' : status === 'delivery_in_progress' ? 'active_delivery' : 'operational_or_traced_order'),
    };
}

function toPublicOrder(row) {
    const items = itemsFromRow(row);
    return {
        id: row.id,
        mesa: row.table_id || row.mesa || null,
        table_id: row.table_id || row.mesa || null,
        visit_id: row.visit_id || null,
        session_id: row.session_id || null,
        order_sequence: row.order_sequence === null || row.order_sequence === undefined ? null : Number(row.order_sequence),
        order_kind: row.order_kind || null,
        status: STATUS_ALIASES[row.status] || row.status || 'draft',
        estado: row.estado || row.status || 'draft',
        items,
        productos: items.map(item => ({ nombre: item.nombre || '', cantidad: Number(item.cantidad) || 1 })),
        subtotal: Number(row.subtotal || 0),
        total: Number(row.total || 0),
        created_at: row.created_at || row.timestamp || null,
        updated_at: row.updated_at || row.timestamp || null,
        confirmed_at: row.confirmed_at || null,
        delivered_at: row.delivered_at || null,
        cancelled_at: row.cancelled_at || null,
        is_test: Boolean(row.is_test),
        data_origin: DATA_ORIGINS.has(row.data_origin) ? row.data_origin : 'customer_order',
        retention_class: row.retention_class || (row.is_test ? 'test' : 'operational'),
        archived_at: row.archived_at || null,
        archived_by: row.archived_by || null,
        archive_reason: row.archive_reason || null,
        deleted_at: row.deleted_at || null,
        deletion_reason: row.deletion_reason || null,
        visit_status: row.visit_status || null,
        visit_closed_at: row.visit_closed_at || null,
        ...classifyRow(row),
    };
}

function canonicalSnapshot(rows) {
    return rows.map(row => ({
        id: String(row.id),
        status: row.status,
        updated_at: row.updated_at || null,
        archived_at: row.archived_at || null,
        is_test: Boolean(row.is_test),
        session_id: row.session_id || null,
        visit_status: row.visit_status || null,
        requires_human: Boolean(row.requires_human),
        requires_special_confirmation: Boolean(row.requires_special_confirmation),
        timestamp: row.timestamp || null,
    })).sort((a, b) => a.id.localeCompare(b.id));
}

function canonicalCleanupScope(scope = null) {
    if (!scope) return null;
    return {
        visit_rows: (scope.visit_rows || []).map(row => ({
            visit_id: String(row.visit_id),
            status: row.status || null,
            updated_at: row.updated_at || null,
            order_ids: row.order_ids || [],
        })).sort((a, b) => a.visit_id.localeCompare(b.visit_id)),
        profile_rows: (scope.profile_rows || []).map(row => ({
            profile_id: String(row.profile_id),
            updated_at: row.updated_at || null,
        })).sort((a, b) => a.profile_id.localeCompare(b.profile_id)),
        event_rows: (scope.event_rows || []).map(row => ({
            id: String(row.id),
            timestamp: row.timestamp || null,
        })).sort((a, b) => a.id.localeCompare(b.id)),
    };
}

function policySignature(policy = {}) {
    return JSON.stringify({
        draft_hours: Number(policy.draft_hours),
        test_hours: Number(policy.test_hours),
        delivered_days: Number(policy.delivered_days),
        cancelled_days: Number(policy.cancelled_days),
        audit_days: Number(policy.audit_days),
        auto_delete_historical: Boolean(policy.auto_delete_historical),
    });
}

function digestSnapshot(rows, policy = null, scope = null) {
    return createHash('sha256').update(JSON.stringify({
        rows: canonicalSnapshot(rows),
        policy: policySignature(policy || {}),
        scope: canonicalCleanupScope(scope),
    })).digest('hex');
}

function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[\t\r\n ]*[=+\-@]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""').replaceAll('\r', ' ').replaceAll('\n', ' ')}"`;
}

function csvValue(order, field) {
    if (field === 'productos') return order.productos.map(item => `${item.nombre} x${item.cantidad}`).join(' | ');
    return order[field] ?? '';
}

export function ordersToCsv(orders) {
    const fields = ['order_id', 'mesa', 'visit_id', 'tipo_pedido', 'estado', 'fecha_creacion', 'fecha_confirmacion', 'fecha_entrega', 'productos', 'total', 'archivado', 'origen'];
    const mapping = ['id', 'table_id', 'visit_id', 'order_kind', 'status', 'created_at', 'confirmed_at', 'delivered_at', 'productos', 'total', 'archived_at', 'data_origin'];
    const header = fields.map(csvCell).join(',');
    const rows = orders.map(order => mapping.map(field => csvCell(csvValue(order, field))).join(','));
    return `\uFEFF${[header, ...rows].join('\n')}\n`;
}

function toExportOrder(order) {
    return {
        order_id: order.id,
        mesa: order.table_id || order.mesa || null,
        visit_id: order.visit_id || null,
        tipo_pedido: order.order_kind || null,
        estado: order.status || order.estado || 'draft',
        fecha_creacion: order.created_at || null,
        fecha_confirmacion: order.confirmed_at || null,
        fecha_entrega: order.delivered_at || null,
        productos: order.productos || [],
        total: Number(order.total || 0),
        archivado: order.archived_at || null,
        origen: order.data_origin || 'customer_order',
    };
}

function summarizeCandidates(rows, scope = null) {
    const byStatus = {};
    const byAction = {};
    const tables = new Set();
    let itemCount = 0;
    for (const row of rows) {
        const status = row.status || 'unknown';
        byStatus[status] = (byStatus[status] || 0) + 1;
        const action = row.action_type || (row.is_test ? 'test_delete' : status === 'draft' ? 'draft_delete' : 'archive');
        byAction[action] = (byAction[action] || 0) + 1;
        if (row.table_id) tables.add(row.table_id);
        itemCount += itemsFromRow(row).length;
    }
    const dates = rows.map(row => row.updated_at || row.created_at || row.timestamp).filter(Boolean).sort();
    const visitIds = new Set(rows.map(row => row.visit_id).filter(Boolean));
    for (const visit of scope?.visit_rows || []) visitIds.add(String(visit.visit_id));
    const dependencyCounts = {
        visits: visitIds.size,
        profiles: scope?.profile_rows?.length || 0,
        events: scope?.event_rows?.length || 0,
    };
    const orderCount = rows.length;
    const dependencyCount = Object.values(dependencyCounts).reduce((sum, value) => sum + value, 0);
    return {
        count: orderCount + dependencyCount,
        order_count: orderCount,
        dependency_count: dependencyCount,
        item_count: itemCount,
        by_status: byStatus,
        by_action: byAction,
        tables: [...tables].sort(),
        dependencies: dependencyCounts,
        data_types: { orders: orderCount, visits: dependencyCounts.visits, profiles: dependencyCounts.profiles, events: dependencyCounts.events },
        date_range: { from: dates[0] || null, to: dates.at(-1) || null },
        estimated_bytes: null,
        reversible: Object.keys(byAction).every(action => action === 'archive'),
    };
}

function retentionDate(row, action) {
    if (action === 'archive_delivered') return row.delivered_at || row.updated_at || row.created_at || row.timestamp;
    if (action === 'archive_cancelled') return row.cancelled_at || row.updated_at || row.created_at || row.timestamp;
    return row.updated_at || row.created_at || row.timestamp;
}

export function isMaintenanceCandidate(row, { action, policy = DEFAULT_POLICY, now = new Date() } = {}) {
    const status = STATUS_ALIASES[row?.status] || row?.status;
    const visitStatus = row?.visit_status || null;
    const hasActiveReference = visitStatus === 'active'
        || Boolean(row?.requires_human)
        || Boolean(row?.requires_special_confirmation)
        || (!row?.visit_id && Boolean(row?.session_id));
    const noActiveReference = !hasActiveReference;
    const timestamp = retentionDate(row || {}, action);
    const ageMs = timestamp ? new Date(now).getTime() - new Date(timestamp).getTime() : -1;
    if (!Number.isFinite(ageMs) || ageMs < 0) return false;
    if (action === 'test_delete') {
        return Boolean(row?.is_test)
            && !['sent_to_kitchen', 'confirmed', 'preparing', 'ready', 'delivery_in_progress'].includes(status)
            && noActiveReference
            && ageMs >= Number(policy.test_hours) * 60 * 60 * 1000;
    }
    if (action === 'draft_delete') {
        return status === 'draft'
            && noActiveReference
            && ageMs >= Number(policy.draft_hours) * 60 * 60 * 1000;
    }
    if (action === 'archive_delivered') {
        return status === 'delivered'
            && !row?.archived_at
            && visitStatus === 'closed'
            && ageMs >= Number(policy.delivered_days) * 24 * 60 * 60 * 1000;
    }
    if (action === 'archive_cancelled') {
        return status === 'cancelled'
            && !row?.archived_at
            && visitStatus === 'closed'
            && ageMs >= Number(policy.cancelled_days) * 24 * 60 * 60 * 1000;
    }
    return false;
}

export class OrderHistoryService {
    constructor({ pool, notify = null, tableService = null, temporaryMemoryService = null, logger = console, now = () => new Date() } = {}) {
        if (!pool) throw new Error('OrderHistoryService requiere un pool PostgreSQL.');
        this.pool = pool;
        this.notify = typeof notify === 'function' ? notify : null;
        this.tableService = tableService;
        this.temporaryMemoryService = temporaryMemoryService;
        this.logger = logger;
        this.now = now;
        this.previews = new Map();
        this.rateState = new Map();
    }

    _actor(actor) {
        const value = String(actor || 'admin').trim().slice(0, 120);
        return value || 'admin';
    }

    _rateLimit(key, windowMs = 1500) {
        const now = Date.now();
        const previous = this.rateState.get(key) || 0;
        if (now - previous < windowMs) throw new OrderHistoryError('La operación se está ejecutando; espera un momento.', 'RATE_LIMITED', 429);
        this.rateState.set(key, now);
    }

    async _audit({ event, actor = 'admin', orderId = null, count = 0, filters = {}, reason = null, result = 'ok', error = null, client = null, metadata = {} } = {}) {
        const target = client || this.pool;
        await target.query(
            `INSERT INTO pedido_eventos
                (event, order_id, actor, source, previous_state, next_state, metadata, is_test)
             VALUES ($1, $2, $3, 'admin_history', '{}'::jsonb, '{}'::jsonb, $4::jsonb, false)`,
            [event, orderId, this._actor(actor), JSON.stringify({ count, filters, reason, result, error: error ? String(error).slice(0, 300) : null, ...metadata })],
        );
    }

    _notify(payload) {
        try {
            const eventType = payload.event || 'history_updated';
            const eventPayload = { filter_summary: {}, ...payload };
            this.notify?.({ type: eventType, ...eventPayload });
            if (eventType !== 'history_updated') this.notify?.({ type: 'history_updated', ...eventPayload });
        } catch (error) { this.logger.warn?.('[OrderHistory] WebSocket:', error.message); }
    }

    async _queryRows(query, { limit, offset } = {}) {
        const where = buildHistoryWhere(query);
        const values = [...where.values];
        const limitPosition = values.length + 1;
        const offsetPosition = values.length + 2;
        const sql = `
            SELECT p.*, v.status AS visit_status, v.closed_at AS visit_closed_at,
                   COUNT(*) OVER()::integer AS total_count
              FROM pedidos p
              LEFT JOIN restaurant_visits v ON v.visit_id = p.visit_id
              ${where.sql}
             ORDER BY ${SORTS[query.sort]}
             LIMIT $${limitPosition} OFFSET $${offsetPosition}`;
        values.push(limit, offset);
        const result = await this.pool.query(sql, values);
        const total = result.rows[0]
            ? Number(result.rows[0].total_count || 0)
            : Number((await this.pool.query(`SELECT COUNT(*)::integer AS total_count FROM pedidos p LEFT JOIN restaurant_visits v ON v.visit_id = p.visit_id ${where.sql}`, where.values)).rows[0]?.total_count || 0);
        return { rows: result.rows, total };
    }

    async listOrders(input = {}, { actor = 'admin', audit = true } = {}) {
        const query = normalizeHistoryQuery(input, { now: this.now() });
        const offset = (query.page - 1) * query.page_size;
        const { rows, total } = await this._queryRows(query, { limit: query.page_size, offset });
        if (audit) await this._audit({ event: 'history_viewed', actor, count: rows.length, filters: query });
        const totalPages = total === 0 ? 0 : Math.ceil(total / query.page_size);
        return {
            items: rows.map(toPublicOrder),
            pagination: {
                page: query.page,
                page_size: query.page_size,
                total_items: total,
                total_pages: totalPages,
                has_next: query.page < totalPages,
                has_previous: query.page > 1 && totalPages > 0,
            },
            filters: query,
            timezone: 'UTC para filtros; es-PE para visualización del Admin',
        };
    }

    async summary({ actor = 'admin' } = {}) {
        const today = normalizeHistoryQuery({ view: 'all', date_preset: 'today', page_size: 1 }, { now: this.now() });
        const where = buildHistoryWhere(today);
        const [totals, hours, popular] = await Promise.all([
            this.pool.query(`SELECT COUNT(*)::integer AS order_count, COALESCE(SUM(p.total), 0)::numeric AS total_amount
                FROM pedidos p LEFT JOIN restaurant_visits v ON v.visit_id = p.visit_id ${where.sql}`, where.values),
            this.pool.query(`SELECT EXTRACT(HOUR FROM (p.created_at AT TIME ZONE 'America/Lima'))::integer AS hour,
                    COALESCE(SUM(p.total), 0)::numeric AS total
                FROM pedidos p LEFT JOIN restaurant_visits v ON v.visit_id = p.visit_id ${where.sql}
                GROUP BY 1 ORDER BY 1`, where.values),
            this.pool.query(`SELECT item->>'nombre' AS nombre, SUM(COALESCE((item->>'cantidad')::numeric, 1))::numeric AS cantidad
                FROM pedidos p LEFT JOIN restaurant_visits v ON v.visit_id = p.visit_id
                CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.items, p.platos, '[]'::jsonb)) item
                ${where.sql} AND p.status <> 'cancelled'
                GROUP BY item->>'nombre' ORDER BY cantidad DESC, nombre ASC LIMIT 8`, where.values),
        ]);
        await this._audit({ event: 'history_viewed', actor, count: Number(totals.rows[0]?.order_count || 0), filters: { view: 'summary', date_preset: 'today' } });
        return {
            order_count: Number(totals.rows[0]?.order_count || 0),
            total_amount: Number(totals.rows[0]?.total_amount || 0),
            ventas_por_hora: hours.rows.map(row => ({ h: `${Number(row.hour) % 12 || 12}${Number(row.hour) < 12 ? 'am' : 'pm'}`, ventas: Number(row.total || 0) })),
            productos_mas_solicitados: popular.rows.map(row => ({ nombre: row.nombre || 'Sin nombre', cantidad: Number(row.cantidad || 0) })),
            timezone: 'America/Lima',
        };
    }

    async getOrder(id) {
        id = assertUuid(id);
        const result = await this.pool.query(
            `SELECT p.*, v.status AS visit_status, v.closed_at AS visit_closed_at
               FROM pedidos p LEFT JOIN restaurant_visits v ON v.visit_id = p.visit_id
              WHERE p.id = $1 AND p.deleted_at IS NULL`,
            [id],
        );
        return result.rows[0] ? toPublicOrder(result.rows[0]) : null;
    }

    async archiveOrder(id, { actor = 'admin', reason, operation = 'manual' } = {}) {
        id = assertUuid(id);
        const safeReason = String(reason || '').trim().slice(0, 500);
        if (!safeReason) throw new OrderHistoryError('El motivo de archivado es obligatorio.', 'REASON_REQUIRED');
        await this._audit({ event: 'order_archive_requested', actor, orderId: id, count: 1, reason: safeReason, result: 'requested' });
        const client = await this.pool.connect();
        let result;
        try {
            await client.query('BEGIN');
            const current = await client.query(
                `SELECT p.*, v.status AS visit_status, v.closed_at AS visit_closed_at
                   FROM pedidos p LEFT JOIN restaurant_visits v ON v.visit_id = p.visit_id
                  WHERE p.id = $1 AND p.deleted_at IS NULL FOR UPDATE OF p`,
                [id],
            );
            if (!current.rows[0]) throw new OrderHistoryError('Pedido no encontrado.', 'ORDER_NOT_FOUND', 404);
            const row = current.rows[0];
            if (row.archived_at) {
                await client.query('COMMIT');
                return { order: toPublicOrder(row), archived: false, idempotent: true };
            }
            const status = STATUS_ALIASES[row.status] || row.status;
            if (!HISTORICAL_STATUSES.includes(status)) throw new OrderHistoryError('Solo se archivan pedidos entregados o cancelados.', 'ORDER_ARCHIVE_FORBIDDEN', 409);
            if (!row.visit_id || row.visit_status !== 'closed') throw new OrderHistoryError('La visita del pedido todavía no está cerrada.', 'VISIT_NOT_CLOSED', 409);
            result = await client.query(
                `UPDATE pedidos SET archived_at = NOW(), archived_by = $2, archive_reason = $3,
                    retention_class = 'archived', updated_at = NOW()
                  WHERE id = $1 AND archived_at IS NULL AND status = $4
                  RETURNING *`,
                [id, this._actor(actor), safeReason, status],
            );
            if (!result.rows[0]) throw new OrderHistoryError('El pedido cambió antes de archivarse.', 'ORDER_CHANGED', 409);
            await this._audit({ event: 'order_archived', actor, orderId: id, count: 1, reason: safeReason, result: operation, client, metadata: { status } });
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        const order = await this.getOrder(id);
        this._notify({ event: 'order_archived', order_id: id, count: 1, actor: this._actor(actor), reason: safeReason, filter_summary: { scope: 'single_order', status: order?.status || null }, result: 'ok', timestamp: this.now().toISOString() });
        return { order, archived: true, idempotent: false };
    }

    async unarchiveOrder(id, { actor = 'admin', reason } = {}) {
        id = assertUuid(id);
        const safeReason = String(reason || '').trim().slice(0, 500);
        if (!safeReason) throw new OrderHistoryError('El motivo de desarchivado es obligatorio.', 'REASON_REQUIRED');
        await this._audit({ event: 'order_unarchive_requested', actor, orderId: id, count: 1, reason: safeReason, result: 'requested' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const current = await client.query('SELECT * FROM pedidos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
            if (!current.rows[0]) throw new OrderHistoryError('Pedido no encontrado.', 'ORDER_NOT_FOUND', 404);
            if (!current.rows[0].archived_at) {
                await client.query('COMMIT');
                return { order: toPublicOrder(current.rows[0]), unarchived: false, idempotent: true };
            }
            const updated = await client.query(
                `UPDATE pedidos SET archived_at = NULL, archived_by = NULL, archive_reason = NULL,
                    retention_class = CASE WHEN is_test THEN 'test' ELSE 'operational' END, updated_at = NOW()
                  WHERE id = $1 AND archived_at IS NOT NULL RETURNING *`,
                [id],
            );
            await this._audit({ event: 'order_unarchived', actor, orderId: id, count: 1, reason: safeReason, client, metadata: { previous_archived_at: current.rows[0].archived_at } });
            await client.query('COMMIT');
            const order = await this.getOrder(id);
            this._notify({ event: 'order_unarchived', order_id: id, count: 1, actor: this._actor(actor), reason: safeReason, filter_summary: { scope: 'single_order', status: order?.status || null }, result: 'ok', timestamp: this.now().toISOString() });
            return { order, unarchived: Boolean(updated.rows[0]), idempotent: false };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async deleteOrder(id, { actor = 'admin', reason, confirm = false } = {}) {
        id = assertUuid(id);
        const safeReason = String(reason || '').trim().slice(0, 500);
        if (!confirm) throw new OrderHistoryError('confirm=true es obligatorio para borrar.', 'CONFIRMATION_REQUIRED');
        if (!safeReason) throw new OrderHistoryError('El motivo de borrado es obligatorio.', 'REASON_REQUIRED');
        await this._audit({ event: 'order_delete_requested', actor, orderId: id, count: 1, reason: safeReason, result: 'requested' });
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const current = await client.query('SELECT * FROM pedidos WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
            if (!current.rows[0]) throw new OrderHistoryError('Pedido no encontrado.', 'ORDER_NOT_FOUND', 404);
            const row = current.rows[0];
            const visitResult = row.visit_id
                ? await client.query('SELECT status FROM restaurant_visits WHERE visit_id = $1 FOR UPDATE', [row.visit_id])
                : { rows: [] };
            const visitStatus = visitResult.rows[0]?.status || null;
            const status = STATUS_ALIASES[row.status] || row.status;
            const activeOperational = ['sent_to_kitchen', 'confirmed', 'preparing', 'ready', 'delivery_in_progress'].includes(status);
            if (activeOperational || status === 'delivered' || status === 'cancelled' || status === 'closed') {
                if (!row.is_test || activeOperational) {
                    await this._audit({ event: 'protected_order_delete_rejected', actor, orderId: id, count: 1, reason: safeReason, result: 'rejected', error: 'protected_status', client, metadata: { status } });
                    await client.query('COMMIT');
                    throw new OrderHistoryError('Los pedidos operativos o históricos están protegidos; use archivado.', 'PROTECTED_ORDER_DELETE', 409);
                }
            }
            if (status === 'draft' && (row.session_id || visitStatus === 'active' || row.requires_human || row.requires_special_confirmation)) {
                throw new OrderHistoryError('El borrador tiene una atención o visita activa.', 'ACTIVE_DRAFT_PROTECTED', 409);
            }
            const deleted = await client.query(
                `DELETE FROM pedidos WHERE id = $1 AND status = $2 AND (is_test = true OR status = 'draft') RETURNING id, visit_id, is_test`,
                [id, row.status],
            );
            if (!deleted.rows[0]) throw new OrderHistoryError('El pedido cambió antes de borrarse.', 'ORDER_CHANGED', 409);
            if (row.visit_id) {
                await client.query(
                    `UPDATE restaurant_visits SET order_ids = COALESCE((
                        SELECT jsonb_agg(value) FROM jsonb_array_elements_text(COALESCE(order_ids, '[]'::jsonb)) values(value)
                        WHERE value <> $1
                    ), '[]'::jsonb), version = version + 1, updated_at = NOW() WHERE visit_id = $2`,
                    [String(id), row.visit_id],
                );
            }
            if (row.is_test && row.visit_id) {
                await client.query('DELETE FROM restaurant_visits WHERE visit_id = $1 AND is_test = true AND NOT EXISTS (SELECT 1 FROM pedidos WHERE visit_id = $1)', [row.visit_id]);
            }
            await this._audit({ event: 'order_deleted', actor, orderId: id, count: 1, reason: safeReason, client, metadata: { status, is_test: Boolean(row.is_test) } });
            await client.query('COMMIT');
            this._notify({ event: 'order_deleted', order_id: id, count: 1, actor: this._actor(actor), reason: safeReason, filter_summary: { scope: 'single_order', status, is_test: Boolean(row.is_test) }, result: 'ok', timestamp: this.now().toISOString() });
            return { deleted: true, id, is_test: Boolean(row.is_test), status };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async getRetentionPolicy(executor = this.pool, { forUpdate = false } = {}) {
        const result = await executor.query(`SELECT * FROM order_retention_policy WHERE id = 1${forUpdate ? ' FOR UPDATE' : ''}`);
        const row = result.rows[0] || DEFAULT_POLICY;
        return {
            draft_hours: Number(row.draft_hours),
            test_hours: Number(row.test_hours),
            delivered_days: Number(row.delivered_days),
            cancelled_days: Number(row.cancelled_days),
            audit_days: Number(row.audit_days),
            auto_delete_historical: Boolean(row.auto_delete_historical),
            updated_at: row.updated_at || null,
            updated_by: row.updated_by || null,
        };
    }

    async updateRetentionPolicy(input = {}, { actor = 'admin', reason = 'policy_update' } = {}) {
        const current = await this.getRetentionPolicy();
        const policy = { ...current };
        for (const field of ['draft_hours', 'test_hours', 'delivered_days', 'cancelled_days', 'audit_days']) {
            if (input[field] !== undefined) policy[field] = parseNumeric(input[field], field, { integer: true, min: 0, max: field.endsWith('_hours') ? 8760 : 3650 });
        }
        if (input.auto_delete_historical !== undefined && parseBoolean(input.auto_delete_historical, 'auto_delete_historical') === true) {
            throw new OrderHistoryError('El borrado automático de históricos reales está desactivado por seguridad.', 'AUTO_DELETE_HISTORY_FORBIDDEN', 409);
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const locked = await this.getRetentionPolicy(client, { forUpdate: true });
            const result = await client.query(
                `UPDATE order_retention_policy SET draft_hours = $1, test_hours = $2, delivered_days = $3,
                    cancelled_days = $4, audit_days = $5, auto_delete_historical = false, updated_at = NOW(), updated_by = $6
                  WHERE id = 1 RETURNING *`,
                [
                    input.draft_hours === undefined ? locked.draft_hours : policy.draft_hours,
                    input.test_hours === undefined ? locked.test_hours : policy.test_hours,
                    input.delivered_days === undefined ? locked.delivered_days : policy.delivered_days,
                    input.cancelled_days === undefined ? locked.cancelled_days : policy.cancelled_days,
                    input.audit_days === undefined ? locked.audit_days : policy.audit_days,
                    this._actor(actor),
                ],
            );
            await this._audit({ event: 'retention_policy_updated', actor, count: 1, reason, result: 'ok', metadata: { policy: result.rows[0] }, client });
            await client.query('COMMIT');
            return this.getRetentionPolicy();
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async _maintenanceRows(kind = 'maintenance') {
        const policy = await this.getRetentionPolicy();
        const query = `
            SELECT p.*, v.status AS visit_status, v.closed_at AS visit_closed_at,
                CASE
                    WHEN p.is_test = true AND p.status NOT IN ('sent_to_kitchen','confirmed','preparing','ready','delivery_in_progress')
                        AND COALESCE(p.updated_at, p.created_at, p.timestamp) < NOW() - ($2::integer * INTERVAL '1 hour')
                        AND (v.status = 'closed' OR (v.status IS NULL AND p.session_id IS NULL))
                        AND COALESCE(p.requires_human, false) = false
                        AND COALESCE(p.requires_special_confirmation, false) = false
                        AND (v.status IS NULL OR v.status = 'closed') THEN 'test_delete'
                    WHEN p.status = 'draft' AND COALESCE(p.updated_at, p.created_at, p.timestamp) < NOW() - ($1::integer * INTERVAL '1 hour')
                        AND (v.status = 'closed' OR (v.status IS NULL AND p.session_id IS NULL))
                        AND COALESCE(p.requires_human, false) = false
                        AND COALESCE(p.requires_special_confirmation, false) = false
                        AND (v.status IS NULL OR v.status = 'closed') THEN 'draft_delete'
                    WHEN p.status = 'delivered' AND p.archived_at IS NULL AND COALESCE(p.delivered_at, p.updated_at, p.created_at, p.timestamp) < NOW() - ($3::integer * INTERVAL '1 day')
                        AND v.status = 'closed' THEN 'archive_delivered'
                    WHEN p.status = 'cancelled' AND p.archived_at IS NULL AND COALESCE(p.cancelled_at, p.updated_at, p.created_at, p.timestamp) < NOW() - ($4::integer * INTERVAL '1 day')
                        AND v.status = 'closed' THEN 'archive_cancelled'
                END AS action_type
              FROM pedidos p LEFT JOIN restaurant_visits v ON v.visit_id = p.visit_id
             WHERE p.deleted_at IS NULL
               AND ((p.is_test = true AND p.status NOT IN ('sent_to_kitchen','confirmed','preparing','ready','delivery_in_progress')
                     AND COALESCE(p.updated_at, p.created_at, p.timestamp) < NOW() - ($2::integer * INTERVAL '1 hour')
                     AND (v.status = 'closed' OR (v.status IS NULL AND p.session_id IS NULL))
                     AND COALESCE(p.requires_human, false) = false AND COALESCE(p.requires_special_confirmation, false) = false AND (v.status IS NULL OR v.status = 'closed'))
                 OR (p.status = 'draft' AND COALESCE(p.updated_at, p.created_at, p.timestamp) < NOW() - ($1::integer * INTERVAL '1 hour')
                     AND (v.status = 'closed' OR (v.status IS NULL AND p.session_id IS NULL))
                     AND COALESCE(p.requires_human, false) = false AND COALESCE(p.requires_special_confirmation, false) = false AND (v.status IS NULL OR v.status = 'closed'))
                 OR (p.status = 'delivered' AND p.archived_at IS NULL AND COALESCE(p.delivered_at, p.updated_at, p.created_at, p.timestamp) < NOW() - ($3::integer * INTERVAL '1 day') AND v.status = 'closed')
                 OR (p.status = 'cancelled' AND p.archived_at IS NULL AND COALESCE(p.cancelled_at, p.updated_at, p.created_at, p.timestamp) < NOW() - ($4::integer * INTERVAL '1 day') AND v.status = 'closed'))
             ORDER BY COALESCE(p.updated_at, p.created_at, p.timestamp) ASC, p.id ASC`;
        const result = await this.pool.query(query, [policy.draft_hours, policy.test_hours, policy.delivered_days, policy.cancelled_days]);
        return { rows: result.rows, policy, kind };
    }

    async _testCleanupScope(executor = this.pool, { policy = DEFAULT_POLICY, forUpdate = false } = {}) {
        const lock = forUpdate ? ' FOR UPDATE' : '';
        const [visits, profiles, events] = await Promise.all([
            executor.query(`SELECT visit_id, status, updated_at, order_ids FROM restaurant_visits
                WHERE is_test = true AND status = 'closed'
                  AND COALESCE(updated_at, opened_at) < NOW() - ($1::integer * INTERVAL '1 hour')
                ORDER BY visit_id${lock}`, [policy.test_hours]),
            executor.query(`SELECT profile_id, updated_at FROM customer_profiles
                WHERE is_test = true AND updated_at < NOW() - ($1::integer * INTERVAL '1 hour')
                ORDER BY profile_id${lock}`, [policy.test_hours]),
            executor.query(`SELECT id, timestamp FROM pedido_eventos
                WHERE is_test = true AND timestamp < NOW() - ($1::integer * INTERVAL '1 hour')
                ORDER BY id${lock}`, [policy.test_hours]),
        ]);
        return {
            visit_rows: visits.rows,
            profile_rows: profiles.rows,
            event_rows: events.rows,
        };
    }

    async _auditRetentionStatus(policy, executor = this.pool) {
        const result = await executor.query(
            `SELECT COUNT(*)::integer AS candidate_count
               FROM pedido_eventos
              WHERE source = 'admin_history'
                AND timestamp < NOW() - ($1::integer * INTERVAL '1 day')`,
            [policy.audit_days],
        );
        return {
            policy_days: Number(policy.audit_days),
            candidate_count: Number(result.rows[0]?.candidate_count || 0),
            automatic_delete: false,
        };
    }

    async previewCleanup({ kind = 'maintenance', actor = 'admin' } = {}) {
        if (!['maintenance', 'test', 'draft'].includes(kind)) throw new OrderHistoryError('Tipo de limpieza no soportado.', 'INVALID_CLEANUP_KIND');
        this._rateLimit(`preview:${actor}`, 500);
        const { rows, policy } = await this._maintenanceRows(kind);
        const selected = rows.filter(row => kind === 'maintenance'
            || (kind === 'test' && row.action_type === 'test_delete')
            || (kind === 'draft' && row.action_type === 'draft_delete'));
        const scope = kind === 'test' ? await this._testCleanupScope(this.pool, { policy }) : null;
        const token = randomUUID();
        const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
        const hash = digestSnapshot(selected, policy, scope);
        this.previews.set(token, {
            kind,
            actor: this._actor(actor),
            expiresAt,
            hash,
            ids: selected.map(row => String(row.id)),
            rows: selected.map(row => ({ ...canonicalSnapshot([row])[0], action_type: row.action_type })),
            policy,
            scope,
        });
        const summary = summarizeCandidates(selected, scope);
        summary.audit_retention = await this._auditRetentionStatus(policy);
        await this._audit({ event: 'retention_preview_generated', actor, count: summary.count, filters: { kind }, result: 'ok', metadata: { hash, expires_at: expiresAt, summary } });
        if (kind === 'test') await this._audit({ event: 'test_cleanup_preview_generated', actor, count: summary.count, filters: { kind }, result: 'preview' });
        return { preview_token: token, candidate_hash: hash, expires_at: expiresAt, kind, summary, policy };
    }

    async _assertFreshPreview(preview, executor = this.pool) {
        if (!preview || new Date(preview.expiresAt).getTime() <= Date.now()) throw new OrderHistoryError('La vista previa expiró; genera una nueva.', 'STALE_CLEANUP_PREVIEW', 409);
        const currentPolicy = await this.getRetentionPolicy(executor, { forUpdate: true });
        if (policySignature(currentPolicy) !== policySignature(preview.policy)) {
            throw new OrderHistoryError('La política de retención cambió; genera una nueva vista previa.', 'STALE_CLEANUP_PREVIEW', 409);
        }
        const result = await executor.query(
            `SELECT p.*, v.status AS visit_status, v.closed_at AS visit_closed_at
               FROM pedidos p LEFT JOIN restaurant_visits v ON v.visit_id = p.visit_id
              WHERE p.id = ANY($1::uuid[]) AND p.deleted_at IS NULL ORDER BY p.id FOR UPDATE OF p`,
            [preview.ids],
        );
        const scope = preview.kind === 'test' ? await this._testCleanupScope(executor, { policy: currentPolicy, forUpdate: true }) : null;
        const currentHash = digestSnapshot(result.rows, currentPolicy, scope);
        if (currentHash !== preview.hash || result.rows.length !== preview.ids.length) throw new OrderHistoryError('Los candidatos cambiaron; genera una nueva vista previa.', 'STALE_CLEANUP_PREVIEW', 409);
        return { rows: result.rows, scope, policy: currentPolicy };
    }

    async executeCleanup({ previewToken, actor = 'admin', confirm = false, reason = null } = {}) {
        if (!confirm) throw new OrderHistoryError('confirm=true es obligatorio para ejecutar limpieza.', 'CONFIRMATION_REQUIRED');
        const safeReason = String(reason || '').trim().slice(0, 500);
        if (!safeReason) throw new OrderHistoryError('El motivo de limpieza es obligatorio.', 'REASON_REQUIRED');
        this._rateLimit(`execute:${actor}`, 1000);
        const preview = this.previews.get(String(previewToken || ''));
        if (!preview) throw new OrderHistoryError('La vista previa no existe o ya fue consumida.', 'STALE_CLEANUP_PREVIEW', 409);
        const client = await this.pool.connect();
        const actorName = this._actor(actor);
        const result = {
            archived: 0,
            deleted_drafts: 0,
            deleted_tests: 0,
            deleted_visits: 0,
            deleted_profiles: 0,
            deleted_events: 0,
            rejected: 0,
            archived_order_ids: [],
            deleted_order_ids: [],
            deleted_visit_ids: [],
            deleted_profile_ids: [],
            deleted_event_ids: [],
            external_cleanup_failed_ids: [],
        };
        let deferredExternalProfileIds = [];
        try {
            await client.query('BEGIN');
            const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [MAINTENANCE_LOCK_KEY]);
            if (!lock.rows[0]?.acquired) throw new OrderHistoryError('Ya existe una limpieza en ejecución.', 'MAINTENANCE_LOCKED', 423);
            this._notify({ event: 'retention_job_started', count: preview.ids.length, actor: actorName, reason: safeReason, filter_summary: { kind: preview.kind, candidate_count: preview.ids.length }, result: 'started', timestamp: this.now().toISOString() });
            if (preview.kind === 'test') await this._audit({ event: 'test_cleanup_started', actor: actorName, count: preview.ids.length, reason: safeReason, result: 'started', client });
            const fresh = await this._assertFreshPreview(preview, client);
            for (const current of fresh.rows) {
                const snapshot = { id: String(current.id) };
                const action = preview.rows.find(item => item.id === snapshot.id)?.action_type;
                if (current.visit_id) {
                    const visit = await client.query('SELECT status FROM restaurant_visits WHERE visit_id = $1 FOR UPDATE', [current.visit_id]);
                    current.visit_status = visit.rows[0]?.status || null;
                }
                if (!isMaintenanceCandidate(current, { action, policy: fresh.policy, now: this.now() })) {
                    throw new OrderHistoryError('Un candidato dejó de cumplir la política durante la limpieza.', 'STALE_CLEANUP_PREVIEW', 409);
                }
                if (action?.startsWith('archive_')) {
                    await client.query(`UPDATE pedidos SET archived_at = NOW(), archived_by = $2, archive_reason = $3, retention_class = 'archived', updated_at = NOW() WHERE id = $1 AND archived_at IS NULL`, [snapshot.id, actorName, safeReason]);
                    await this._audit({ event: 'order_archived', actor: actorName, orderId: snapshot.id, count: 1, reason: safeReason, client, metadata: { maintenance: true, action } });
                    result.archived += 1;
                    result.archived_order_ids.push(snapshot.id);
                } else if (action === 'test_delete' || action === 'draft_delete') {
                    await this._audit({
                        event: 'order_deleted',
                        actor: actorName,
                        orderId: snapshot.id,
                        count: 1,
                        reason: safeReason,
                        client,
                        metadata: { maintenance: true, action, status: current.status, is_test: Boolean(current.is_test) },
                    });
                    const deleted = await client.query('DELETE FROM pedidos WHERE id = $1 AND status = $2 AND (is_test = true OR status = \'draft\') RETURNING id', [snapshot.id, current.status]);
                    if (!deleted.rows[0]) throw new OrderHistoryError('El pedido cambió antes de borrarse.', 'STALE_CLEANUP_PREVIEW', 409);
                    if (current.visit_id) {
                        await client.query(`UPDATE restaurant_visits SET order_ids = COALESCE((SELECT jsonb_agg(value) FROM jsonb_array_elements_text(COALESCE(order_ids, '[]'::jsonb)) values(value) WHERE value <> $1), '[]'::jsonb), version = version + 1, updated_at = NOW() WHERE visit_id = $2`, [String(snapshot.id), current.visit_id]);
                    }
                    result[action === 'test_delete' ? 'deleted_tests' : 'deleted_drafts'] += 1;
                    result.deleted_order_ids.push(snapshot.id);
                }
            }
            if (preview.kind === 'test') {
                const scope = fresh.scope || { visit_rows: [], profile_rows: [], event_rows: [] };
                const profileIds = scope.profile_rows.map(row => String(row.profile_id));
                if (profileIds.length && this.temporaryMemoryService?.clearTestProfiles) {
                    const memoryResult = await this.temporaryMemoryService.clearTestProfiles({
                        profileIds,
                        executor: client,
                        actor: actorName,
                        deferExternal: Boolean(this.temporaryMemoryService.clearExternalProfiles),
                    });
                    result.deleted_profiles = Number(memoryResult.deleted_profiles || 0);
                    result.deleted_profile_ids = profileIds;
                    if (memoryResult.external_cleanup_deferred) deferredExternalProfileIds = profileIds;
                } else if (profileIds.length) {
                    const deletedProfiles = await client.query('DELETE FROM customer_profiles WHERE profile_id = ANY($1::uuid[]) AND is_test = true RETURNING profile_id', [profileIds]);
                    result.deleted_profiles = deletedProfiles.rowCount || 0;
                    result.deleted_profile_ids = deletedProfiles.rows.map(row => String(row.profile_id));
                }
                const visitIds = scope.visit_rows.map(row => String(row.visit_id));
                if (visitIds.length) {
                    const deletedVisits = await client.query(`DELETE FROM restaurant_visits
                        WHERE visit_id = ANY($1::uuid[]) AND is_test = true AND status = 'closed'
                          AND NOT EXISTS (SELECT 1 FROM pedidos WHERE visit_id = restaurant_visits.visit_id)
                        RETURNING visit_id`, [visitIds]);
                    result.deleted_visits = deletedVisits.rowCount || 0;
                    result.deleted_visit_ids = deletedVisits.rows.map(row => String(row.visit_id));
                }
                const eventIds = scope.event_rows.map(row => String(row.id));
                if (eventIds.length) {
                    const deletedEvents = await client.query('DELETE FROM pedido_eventos WHERE id = ANY($1::uuid[]) AND is_test = true RETURNING id', [eventIds]);
                    result.deleted_events = deletedEvents.rowCount || 0;
                    result.deleted_event_ids = deletedEvents.rows.map(row => String(row.id));
                }
            }
            await this._audit({ event: 'retention_job_completed', actor: actorName, count: result.archived + result.deleted_drafts + result.deleted_tests, reason: safeReason, result: 'ok', client, metadata: result });
            if (preview.kind === 'test') await this._audit({ event: 'test_cleanup_completed', actor: actorName, count: result.deleted_tests, reason: safeReason, result: 'ok', client, metadata: result });
            await client.query('COMMIT');
            this.previews.delete(previewToken);
            if (deferredExternalProfileIds.length && this.temporaryMemoryService?.clearExternalProfiles) {
                try {
                    await this.temporaryMemoryService.clearExternalProfiles({ profileIds: deferredExternalProfileIds, actor: actorName });
                } catch (error) {
                    result.external_cleanup_failed_ids = deferredExternalProfileIds;
                    await this._audit({
                        event: 'test_profile_external_cleanup_failed',
                        actor: actorName,
                        count: deferredExternalProfileIds.length,
                        reason: safeReason,
                        result: 'pending_retry',
                        error: error.message,
                        metadata: { profile_ids: deferredExternalProfileIds },
                    });
                }
            }
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            if (error.code === 'STALE_CLEANUP_PREVIEW') await this._audit({ event: 'stale_cleanup_preview_rejected', actor: actorName, count: preview.ids.length, reason: safeReason, result: 'rejected', error: error.message });
            await this._audit({ event: 'retention_job_failed', actor: actorName, count: 0, reason: safeReason, result: 'failed', error: error.message });
            this._notify({ event: error.code === 'STALE_CLEANUP_PREVIEW' ? 'cleanup_rejected' : 'retention_job_failed', count: 0, actor: actorName, reason: safeReason, filter_summary: { kind: preview.kind, candidate_count: preview.ids.length }, result: 'rejected', error: error.message, timestamp: this.now().toISOString() });
            throw error;
        } finally {
            client.release();
        }
        const completedCount = result.archived + result.deleted_drafts + result.deleted_tests;
        const completedPayload = { count: completedCount, actor: actorName, reason: safeReason, filter_summary: { kind: preview.kind, candidate_count: preview.ids.length }, result, timestamp: this.now().toISOString() };
        this._notify({ event: 'retention_job_completed', ...completedPayload });
        if (preview.kind === 'test') this._notify({ event: 'test_data_cleanup_completed', ...completedPayload });
        return result;
    }

    async exportOrders(input = {}, { actor = 'admin', format = 'csv' } = {}) {
        this._rateLimit(`export:${actor}`, 1000);
        const query = normalizeHistoryQuery({ ...input, page: 1, page_size: DEFAULT_PAGE_SIZE });
        const { rows, total } = await this._queryRows(query, { limit: MAX_EXPORT_ROWS + 1, offset: 0 });
        if (total > MAX_EXPORT_ROWS) throw new OrderHistoryError(`La exportación supera el máximo seguro de ${MAX_EXPORT_ROWS} registros.`, 'EXPORT_TOO_LARGE', 413);
        const orders = rows.map(toPublicOrder);
        await this._audit({ event: 'history_exported', actor, count: orders.length, filters: query, result: 'ok', metadata: { format } });
        if (format === 'json') return { data: orders.map(toExportOrder), total, filters: query };
        return ordersToCsv(orders);
    }

    async audit({ page = 1, page_size = 25, actor = 'admin' } = {}) {
        const pageNumber = parseNumeric(page, 'page', { integer: true, min: 1, max: 1_000_000 });
        const size = parseNumeric(page_size, 'page_size', { integer: true, min: 1, max: MAX_PAGE_SIZE });
        const offset = (pageNumber - 1) * size;
        const result = await this.pool.query(`SELECT *, COUNT(*) OVER()::integer AS total_count FROM pedido_eventos WHERE source = 'admin_history' ORDER BY timestamp DESC, id DESC LIMIT $1 OFFSET $2`, [size, offset]);
        const total = result.rows[0]
            ? Number(result.rows[0].total_count || 0)
            : Number((await this.pool.query("SELECT COUNT(*)::integer AS total_count FROM pedido_eventos WHERE source = 'admin_history'")).rows[0]?.total_count || 0);
        await this._audit({ event: 'history_viewed', actor, count: result.rows.length, filters: { audit: true, page: pageNumber } });
        return { items: result.rows.map(row => ({ id: row.id, event: row.event, order_id: row.order_id, actor: row.actor, timestamp: row.timestamp, metadata: row.metadata })), pagination: { page: pageNumber, page_size: size, total_items: total, total_pages: total ? Math.ceil(total / size) : 0 } };
    }

    async visitHistory(visitId, input = {}, { actor = 'admin' } = {}) {
        visitId = assertUuid(visitId, 'visit_id');
        const result = await this.pool.query('SELECT * FROM restaurant_visits WHERE visit_id = $1', [visitId]);
        if (!result.rows[0]) throw new OrderHistoryError('Visita no encontrada.', 'VISIT_NOT_FOUND', 404);
        const [orders, aggregate] = await Promise.all([
            this.listOrders({ ...input, view: 'all', visit_id: visitId }, { actor, audit: false }),
            this.pool.query(`SELECT COUNT(*)::integer AS order_count,
                    COUNT(*) FILTER (WHERE order_kind = 'initial')::integer AS initial_count,
                    COUNT(*) FILTER (WHERE order_kind = 'additional')::integer AS additional_count,
                    COUNT(*) FILTER (WHERE status = 'delivered')::integer AS delivered_count,
                    COALESCE(SUM(total), 0)::numeric AS total_amount
               FROM pedidos
              WHERE visit_id = $1 AND deleted_at IS NULL`, [visitId]),
        ]);
        await this._audit({ event: 'history_viewed', actor, count: orders.items.length, filters: { visit_id: visitId } });
        const totals = aggregate.rows[0] || {};
        return {
            visit: {
                visit_id: result.rows[0].visit_id,
                table_id: result.rows[0].table_id,
                status: result.rows[0].status,
                opened_at: result.rows[0].opened_at,
                closed_at: result.rows[0].closed_at,
                close_reason: result.rows[0].close_reason,
                guest_count: result.rows[0].guest_count,
                is_test: Boolean(result.rows[0].is_test),
            },
            orders,
            summary: {
                order_count: Number(totals.order_count || 0),
                initial_count: Number(totals.initial_count || 0),
                additional_count: Number(totals.additional_count || 0),
                delivered_count: Number(totals.delivered_count || 0),
                total_amount: Number(totals.total_amount || 0),
            },
        };
    }
}

export { ACTIVE_STATUSES, HISTORICAL_STATUSES, MAX_PAGE_SIZE, MAX_EXPORT_ROWS, SORTS, toPublicOrder, classifyRow };
