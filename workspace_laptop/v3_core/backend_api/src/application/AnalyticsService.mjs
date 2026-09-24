import {
    ALL_ORDER_STATUSES,
    ANALYTICS_METRIC_DICTIONARY,
    AnalyticsQueryError,
    SALE_STATUSES,
    localizeMetricDictionary,
    normalizeAnalyticsQuery,
    previousPeriod,
} from './AnalyticsMetricDefinitions.mjs';

const EVENT_LATENCY_SPECS = Object.freeze({
    stt: { start: ['stt_started', 'asr_started'], end: ['stt_completed', 'asr_completed'], label: 'STT' },
    llm: { start: ['llm_started', 'processing_started'], end: ['llm_completed', 'processing_completed'], label: 'LLM' },
    tts: { start: ['tts_started', 'speech_started'], end: ['tts_completed', 'speech_completed'], label: 'TTS' },
    turn: { start: ['turn_started', 'session_turn_started'], end: ['turn_completed', 'session_turn_completed'], label: 'turn total' },
    order_to_kitchen: { start: ['order_confirmed', 'pedido_confirmado'], end: ['kitchen_received', 'order_sent_to_kitchen', 'pedido_enviado_cocina'], label: 'pedido a Cocina' },
});

const EVENT_GROUPS = Object.freeze({
    sessions_started: ['session_started'],
    sessions_closed: ['session_closed'],
    sessions_recovered: ['session_recovered'],
    session_timeout_warnings: ['session_timeout_warning'],
    sessions_expired: ['session_expired'],
    modes_selected: ['session_mode_selected'],
    menu_queries: ['menu_requested', 'category_shown', 'product_searched', 'ingredient_query'],
    recommendations: ['recommendation_generated'],
    highlights: ['product_highlighted'],
    ambiguous_references: ['ambiguous_visible_reference'],
    waiter_requests: ['waiter_assistance_requested', 'human_waiter_requested', 'human_waiter_requested_for_allergy'],
    safety_warnings: ['allergy_warning_presented', 'allergen_conflict_detected', 'insufficient_ingredient_data'],
    delivery_events: ['table_delivery_started', 'delivery_started', 'delivery_state_changed'],
});

const SIMULATION_SOURCES = ['admin_simulation', 'ros2_simulation', 'delivery_simulation'];
const REAL_DELIVERY_SOURCES = ['ros2_physical', 'ros2_bridge', 'hardware_delivery'];
const STATUS_ARRAY_SQL = `ARRAY[${SALE_STATUSES.map((status) => `'${status}'`).join(',')}]::text[]`;
const ALL_STATUS_ARRAY_SQL = `ARRAY[${ALL_ORDER_STATUSES.map((status) => `'${status}'`).join(',')}]::text[]`;

function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function toJsonValue(value, fallback = {}) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch { return fallback; }
}

function safeRows(result) {
    return Array.isArray(result?.rows) ? result.rows : [];
}

function statusForSample(sample, minimum = 1) {
    if (sample === 0) return 'no_data';
    if (sample < minimum) return 'insufficient_data';
    return 'ok';
}

function coverage(sample, eligible, period) {
    const denominator = Math.max(number(eligible), 0);
    return {
        sample_size: Math.max(number(sample), 0),
        eligible_rows: denominator,
        ratio: denominator > 0 ? Number((number(sample) / denominator).toFixed(4)) : null,
        period_days: period.days,
    };
}

function metricStats(rows, minimum = 5) {
    const row = rows[0] || {};
    const sample = number(row.sample_size);
    const status = statusForSample(sample, minimum);
    if (status !== 'ok') {
        return { status, sample_size: sample, average_ms: null, p50_ms: null, p95_ms: null, min_ms: null, max_ms: null };
    }
    return {
        status,
        sample_size: sample,
        average_ms: nullableNumber(row.average_ms),
        p50_ms: nullableNumber(row.p50_ms),
        p95_ms: nullableNumber(row.p95_ms),
        min_ms: nullableNumber(row.min_ms),
        max_ms: nullableNumber(row.max_ms),
    };
}

function metricEnvelope(key, value, filters, extra = {}) {
    const definition = ANALYTICS_METRIC_DICTIONARY[key] || { key, label: key, source: 'PostgreSQL', formula: 'aggregate SQL' };
    return { metric: key, definition: { key, ...definition }, value, filters, ...extra };
}

function aliasesForEvent(events) {
    return events.map((event) => `'${event}'`).join(',');
}

export class AnalyticsService {
    constructor({ pool, now = () => new Date(), logger = console, getServiceHealth = null } = {}) {
        if (!pool || typeof pool.query !== 'function') throw new Error('AnalyticsService requiere un pool PostgreSQL');
        this.pool = pool;
        this.now = now;
        this.logger = logger;
        this.getServiceHealth = getServiceHealth;
    }

    normalize(input = {}, options = {}) {
        return normalizeAnalyticsQuery(input, { now: options.now || this.now() });
    }

    _normalize(input = {}) {
        return input?.period && typeof input.period === 'object' && input.period.from && input.period.to
            ? input
            : this.normalize(input);
    }

    _orderScope(filters, { includeStatus = true, excludeTestLike = !filters.include_test, from = filters.period.from, to = filters.period.to } = {}) {
        const values = [from, to];
        const clauses = [
            'p.deleted_at IS NULL',
            `p.is_test = ${filters.include_test ? 'TRUE' : 'FALSE'}`,
            'p.created_at >= $1',
            'p.created_at < $2',
        ];
        if (includeStatus) clauses.push(`p.status = ANY(${STATUS_ARRAY_SQL})`);
        if (excludeTestLike) {
            clauses.push(`NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(COALESCE(p.items, p.platos, '[]'::jsonb)) AS test_item
                 WHERE lower(COALESCE(test_item->>'nombre', '')) ~* '(^|[^a-z])(qa|test|fixture|audit)([^a-z]|$)'
            )`);
        }
        if (filters.table_id) {
            values.push(filters.table_id);
            clauses.push(`COALESCE(p.table_id, p.mesa) = $${values.length}`);
        }
        if (filters.interaction_mode) {
            values.push(filters.interaction_mode);
            clauses.push(`lower(COALESCE(NULLIF(p.mode, ''), NULLIF(p.modo, ''))) = $${values.length}`);
        }
        if (filters.category) {
            values.push(filters.category);
            clauses.push(`EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(p.items, p.platos, '[]'::jsonb)) AS category_item
                WHERE lower(COALESCE(category_item->>'categoria', '')) = $${values.length}
            )`);
        }
        return { sql: clauses.join(' AND '), values };
    }

    _eventScope(filters, events = null, { excludeTestLike = !filters.include_test } = {}) {
        const values = [filters.period.from, filters.period.to];
        const clauses = [
            `e.is_test = ${filters.include_test ? 'TRUE' : 'FALSE'}`,
            'e.timestamp >= $1',
            'e.timestamp < $2',
        ];
        if (events?.length) clauses.push(`e.event = ANY(ARRAY[${aliasesForEvent(events)}]::text[])`);
        if (excludeTestLike) {
            clauses.push(`lower(COALESCE(e.source, '')) !~* '(^|[^a-z])(qa|test|fixture|audit)([^a-z]|$)'
                AND lower(COALESCE(e.metadata->>'source', '')) !~* '(^|[^a-z])(qa|test|fixture|audit)([^a-z]|$)'
                AND lower(COALESCE(e.metadata->>'robot_id', '')) !~* '(^|[^a-z])(qa|test|fixture|audit)([^a-z]|$)'`);
        }
        if (filters.table_id) {
            values.push(filters.table_id);
            clauses.push(`e.mesa = $${values.length}`);
        }
        return { sql: clauses.join(' AND '), values };
    }

    _visitScope(filters) {
        const values = [filters.period.from, filters.period.to];
        const clauses = [
            `v.is_test = ${filters.include_test ? 'TRUE' : 'FALSE'}`,
            'v.opened_at >= $1',
            'v.opened_at < $2',
        ];
        if (filters.table_id) {
            values.push(filters.table_id);
            clauses.push(`v.table_id = $${values.length}`);
        }
        return { sql: clauses.join(' AND '), values };
    }

    _filters(filters) {
        return {
            timezone: filters.timezone,
            period: filters.period,
            table_id: filters.table_id,
            category: filters.category,
            interaction_mode: filters.interaction_mode,
            delivery_mode: filters.delivery_mode,
            include_test: filters.include_test,
            diagnostic: filters.diagnostic,
        };
    }

    async dictionary() {
        return {
            generated_at: this.now().toISOString(),
            timezone_default: 'America/Lima',
            valid_order_statuses: [...SALE_STATUSES],
            excluded_by_default: ['draft', 'pending_confirmation', 'provisional', 'cancelled', 'closed', 'is_test=true', 'patrones QA/test no etiquetados'],
            metrics: localizeMetricDictionary(),
            rules: {
                no_data_is_not_zero: true,
                percentile_minimum_sample: 5,
                source: 'PostgreSQL aggregate SQL; no synthetic fallback',
                test_exclusion: 'is_test=true y patrones QA/test no etiquetados quedan fuera por defecto; diagnostic=true solo habilita include_test.',
                privacy: 'No se exponen nombres, notas, perfiles ni texto libre.',
            },
        };
    }

    async recordAudit({ event = 'analytics_viewed', actor = 'admin', dataset = null, filters = {}, result = 'ok' } = {}) {
        const safeFilters = {
            period: filters.period?.preset || null,
            date_from: filters.period?.from_local || null,
            date_to: filters.period?.to_local_exclusive || null,
            timezone: filters.timezone || null,
            table_id: filters.table_id || null,
            category: filters.category || null,
            interaction_mode: filters.interaction_mode || null,
            delivery_mode: filters.delivery_mode || null,
            include_test: Boolean(filters.include_test),
            diagnostic: Boolean(filters.diagnostic),
        };
        await this.pool.query(`
            INSERT INTO pedido_eventos
                (event, actor, source, previous_state, next_state, metadata, is_test)
             VALUES ($1, $2, 'admin_analytics', '{}'::jsonb, '{}'::jsonb, $3::jsonb, false)`,
        [event, String(actor || 'admin').slice(0, 80), JSON.stringify({ dataset, filters: safeFilters, result })]);
    }

    async _salesAggregate(filters, from, to) {
        const scope = this._orderScope(filters, { from, to });
        const result = await this.pool.query(`
            SELECT COUNT(*)::integer AS valid_orders,
                   COALESCE(SUM(p.total), 0)::numeric AS sales_total,
                   AVG(p.total)::numeric AS average_ticket,
                   COUNT(*) FILTER (WHERE p.order_kind = 'initial')::integer AS initial_orders,
                   COUNT(*) FILTER (WHERE p.order_kind = 'additional')::integer AS additional_orders,
                   COUNT(*) FILTER (WHERE p.status = 'delivered')::integer AS delivered_orders,
                   COUNT(*) FILTER (WHERE p.status IN ('confirmed','sent_to_kitchen','preparing','ready','delivery_in_progress'))::integer AS open_orders
              FROM pedidos p
             WHERE ${scope.sql}`, scope.values);
        return result.rows[0] || {};
    }

    async sales(input = {}) {
        const filters = this._normalize(input);
        const aggregate = await this._salesAggregate(filters, filters.period.from, filters.period.to);
        const previous = previousPeriod(filters.period);
        const previousAggregate = await this._salesAggregate(filters, previous.from, previous.to);
        const scope = this._orderScope(filters);
        const series = await this.pool.query(`
            SELECT to_char(date_trunc($${scope.values.length + 1}, p.created_at AT TIME ZONE $${scope.values.length + 2}), 'YYYY-MM-DD"T"HH24:MI:SS') AS bucket,
                   COUNT(*)::integer AS valid_orders,
                   COALESCE(SUM(p.total), 0)::numeric AS sales_total
              FROM pedidos p
             WHERE ${scope.sql}
             GROUP BY 1 ORDER BY 1`, [...scope.values, filters.granularity, filters.timezone]);
        const validOrders = number(aggregate.valid_orders);
        const salesTotal = number(aggregate.sales_total);
        return {
            data_status: statusForSample(validOrders),
            source: 'PostgreSQL.pedidos',
            filters: this._filters(filters),
            kpis: {
                valid_orders: validOrders,
                sales_total: salesTotal,
                average_ticket: nullableNumber(aggregate.average_ticket),
                initial_orders: number(aggregate.initial_orders),
                additional_orders: number(aggregate.additional_orders),
                additional_order_rate: validOrders ? number(aggregate.additional_orders) / validOrders : null,
                delivered_orders: number(aggregate.delivered_orders),
                open_orders: number(aggregate.open_orders),
            },
            comparison: {
                previous_period: previous,
                sales_total: number(previousAggregate.sales_total),
                valid_orders: number(previousAggregate.valid_orders),
                sales_delta: salesTotal - number(previousAggregate.sales_total),
                sales_delta_rate: number(previousAggregate.sales_total) ? (salesTotal - number(previousAggregate.sales_total)) / number(previousAggregate.sales_total) : null,
            },
            series: safeRows(series).map((row) => ({ bucket: row.bucket, valid_orders: number(row.valid_orders), sales_total: number(row.sales_total) })),
            sample_size: validOrders,
            limitations: validOrders ? [] : ['No hay pedidos válidos en el período seleccionado.'],
        };
    }

    async products(input = {}) {
        const filters = this._normalize(input);
        const scope = this._orderScope(filters);
        const result = await this.pool.query(`
            WITH line_items AS (
                SELECT item,
                       CASE WHEN (item->>'cantidad') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (item->>'cantidad')::numeric ELSE 1 END AS quantity,
                       CASE WHEN (item->>'precio') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (item->>'precio')::numeric ELSE 0 END AS unit_price
                  FROM pedidos p
                  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.items, p.platos, '[]'::jsonb)) AS item
                 WHERE ${scope.sql}
            )
            SELECT COALESCE(item->>'product_id', item->>'id') AS product_id,
                   COALESCE(NULLIF(item->>'nombre', ''), 'Sin nombre registrado') AS product_name,
                   COALESCE(NULLIF(lower(item->>'categoria'), ''), 'sin_categoria') AS category,
                   SUM(quantity)::numeric AS units,
                   SUM(quantity * unit_price)::numeric AS revenue,
                   COUNT(*)::integer AS line_count
              FROM line_items
             GROUP BY 1, 2, 3
             ORDER BY units DESC, revenue DESC, product_name ASC`, scope.values);
        const rows = safeRows(result).map((row) => ({
            product_id: row.product_id || null,
            product_name: row.product_name,
            category: row.category,
            units: number(row.units),
            revenue: number(row.revenue),
            line_count: number(row.line_count),
        }));
        const categories = Object.values(rows.reduce((acc, row) => {
            const key = row.category || 'sin_categoria';
            acc[key] ||= { category: key, units: 0, revenue: 0, product_count: 0 };
            acc[key].units += row.units;
            acc[key].revenue += row.revenue;
            acc[key].product_count += 1;
            return acc;
        }, {})).sort((a, b) => b.units - a.units || a.category.localeCompare(b.category, 'es'));
        return {
            data_status: statusForSample(rows.reduce((sum, row) => sum + row.units, 0)),
            source: 'PostgreSQL.pedidos.items/platos JSONB',
            filters: this._filters(filters),
            products: rows.slice(0, 100),
            top_products: rows.slice(0, 8),
            less_sold_products: [...rows].sort((a, b) => a.units - b.units || a.product_name.localeCompare(b.product_name, 'es')).slice(0, 8),
            categories,
            sample_size: rows.reduce((sum, row) => sum + row.units, 0),
            limitations: rows.length ? [] : ['No hay líneas de productos válidas en el período seleccionado.'],
        };
    }

    async tables(input = {}) {
        const filters = this._normalize(input);
        const visitScope = this._visitScope(filters);
        const [visits, snapshot] = await Promise.all([
            this.pool.query(`
                SELECT v.table_id,
                       COUNT(*)::integer AS visits,
                       COUNT(*) FILTER (WHERE v.closed_at IS NOT NULL)::integer AS closed_visits,
                       AVG(EXTRACT(EPOCH FROM (v.closed_at - v.opened_at)))::numeric AS average_duration_seconds,
                       SUM(COALESCE(v.guest_count, 0))::integer AS guest_count
                  FROM restaurant_visits v
                 WHERE ${visitScope.sql}
                 GROUP BY v.table_id ORDER BY v.table_id`, visitScope.values),
            this.pool.query(`
                SELECT COUNT(*) FILTER (WHERE enabled)::integer AS enabled_tables,
                       COUNT(*) FILTER (WHERE enabled AND status <> 'available')::integer AS occupied_tables,
                       COUNT(*) FILTER (WHERE enabled AND status = 'available')::integer AS available_tables
                  FROM restaurant_tables`, []),
        ]);
        const tableRows = safeRows(visits).map((row) => ({
            table_id: row.table_id,
            visits: number(row.visits),
            closed_visits: number(row.closed_visits),
            average_duration_seconds: nullableNumber(row.average_duration_seconds),
            guest_count: number(row.guest_count),
        }));
        const snapshotRow = snapshot.rows[0] || {};
        const enabled = number(snapshotRow.enabled_tables);
        const occupied = number(snapshotRow.occupied_tables);
        const occupancy = enabled ? occupied / enabled : null;
        return {
            data_status: enabled ? 'ok' : 'no_data',
            source: 'PostgreSQL.restaurant_tables + restaurant_visits',
            filters: this._filters(filters),
            snapshot: {
                scope: 'current_snapshot',
                enabled_tables: enabled,
                occupied_tables: occupied,
                available_tables: number(snapshotRow.available_tables),
                occupancy_rate: occupancy,
            },
            visits: tableRows,
            sample_size: tableRows.reduce((sum, row) => sum + row.visits, 0),
            limitations: [
                'La ocupación es un snapshot actual de restaurant_tables y no una serie histórica del período.',
                ...(tableRows.length ? [] : ['No hay visitas en el período seleccionado.']),
            ],
        };
    }

    async operations(input = {}) {
        const filters = this._normalize(input);
        const orderScope = this._orderScope(filters, { includeStatus: false });
        const eventScope = this._eventScope(filters, ['table_preparing', 'table_ready', 'order_confirmed', 'order_sent_to_kitchen', 'kitchen_received']);
        const [statuses, stages, dataQuality] = await Promise.all([
            this.pool.query(`SELECT p.status, COUNT(*)::integer AS count FROM pedidos p WHERE ${orderScope.sql} GROUP BY p.status ORDER BY p.status`, orderScope.values),
            this.pool.query(`SELECT e.event, COUNT(*)::integer AS count FROM pedido_eventos e WHERE ${eventScope.sql} GROUP BY e.event ORDER BY e.event`, eventScope.values),
            this.pool.query(`SELECT COUNT(*) FILTER (WHERE p.status = 'ready')::integer AS ready_orders,
                                    COUNT(*) FILTER (WHERE p.status = 'preparing')::integer AS preparing_orders,
                                    COUNT(*) FILTER (WHERE p.status = 'sent_to_kitchen')::integer AS sent_to_kitchen_orders
                               FROM pedidos p WHERE ${orderScope.sql}`, orderScope.values),
        ]);
        const stageRows = safeRows(stages).map((row) => ({ event: row.event, count: number(row.count) }));
        const qualityRow = dataQuality.rows[0] || {};
        const stageMap = Object.fromEntries(stageRows.map((row) => [row.event, row.count]));
        const hasKitchenReceipt = Boolean(stageMap.kitchen_received || stageMap.order_sent_to_kitchen);
        const statusSample = safeRows(statuses).reduce((sum, row) => sum + number(row.count), 0);
        return {
            data_status: statusForSample(statusSample),
            source: 'PostgreSQL.pedidos + pedido_eventos',
            filters: this._filters(filters),
            order_statuses: safeRows(statuses).map((row) => ({ status: row.status, count: number(row.count) })),
            kitchen: {
                sent_to_kitchen: number(qualityRow.sent_to_kitchen_orders),
                preparing: number(qualityRow.preparing_orders),
                ready: number(qualityRow.ready_orders),
                stage_events: stageRows,
            },
            latency: {
                status: hasKitchenReceipt ? 'pending_pair_analysis' : 'insufficient_data',
                sample_size: 0,
                p50_ms: null,
                p95_ms: null,
                limitation: 'No hay eventos persistidos de confirmación y recepción en Cocina emparejables.',
            },
            sample_size: statusSample,
            limitations: hasKitchenReceipt ? [] : ['La recepción en Cocina no tiene un evento histórico instrumentado.'],
        };
    }

    async delivery(input = {}) {
        const filters = this._normalize(input);
        const events = ['table_delivery_started', 'delivery_started', 'delivery_state_changed'];
        const scope = this._eventScope(filters, events);
        const values = [...scope.values];
        const modeFilter = filters.delivery_mode === 'simulated'
            ? `AND e.source = ANY(ARRAY[${SIMULATION_SOURCES.map((source) => `'${source}'`).join(',')}]::text[])`
            : filters.delivery_mode === 'real'
                ? `AND e.source = ANY(ARRAY[${REAL_DELIVERY_SOURCES.map((source) => `'${source}'`).join(',')}]::text[])`
                : '';
        const result = await this.pool.query(`
            SELECT CASE WHEN e.source = ANY(ARRAY[${SIMULATION_SOURCES.map((source) => `'${source}'`).join(',')}]::text[]) THEN 'simulated'
                        WHEN e.source = ANY(ARRAY[${REAL_DELIVERY_SOURCES.map((source) => `'${source}'`).join(',')}]::text[]) THEN 'real'
                        ELSE 'unverified' END AS delivery_mode,
                   e.event,
                   COUNT(*)::integer AS count
              FROM pedido_eventos e
             WHERE ${scope.sql} ${modeFilter}
             GROUP BY 1, 2 ORDER BY 1, 2`, values);
        const rows = safeRows(result).map((row) => ({ delivery_mode: row.delivery_mode, event: row.event, count: number(row.count) }));
        const simulated = rows.filter((row) => row.delivery_mode === 'simulated');
        const real = rows.filter((row) => row.delivery_mode === 'real');
        return {
            data_status: rows.length ? 'ok' : 'no_data',
            source: 'PostgreSQL.pedido_eventos',
            filters: this._filters(filters),
            mode: {
                simulated: { available: true, events: simulated, count: simulated.reduce((sum, row) => sum + row.count, 0) },
                real: { available: false, events: real, count: real.reduce((sum, row) => sum + row.count, 0), limitation: 'No existe publicador ROS 2 físico activo en esta arquitectura.' },
                unverified: { events: rows.filter((row) => row.delivery_mode === 'unverified'), count: rows.filter((row) => row.delivery_mode === 'unverified').reduce((sum, row) => sum + row.count, 0), limitation: 'Eventos sin fuente ROS 2 física o simulada explícita; no se cuentan como entregas reales.' },
            },
            sample_size: rows.reduce((sum, row) => sum + row.count, 0),
            limitations: [
                ...(real.length ? ['Los eventos de fuentes físicas requieren validación del adaptador ROS 2.'] : []),
                ...(rows.some((row) => row.delivery_mode === 'unverified') ? ['Hay eventos de entrega sin origen explícito; no se cuentan como reales.'] : []),
            ],
        };
    }

    async hri(input = {}) {
        const filters = this._normalize(input);
        const eventNames = [...new Set(Object.values(EVENT_GROUPS).flat())];
        const scope = this._eventScope(filters, eventNames);
        const [events, modes, orders] = await Promise.all([
            this.pool.query(`SELECT e.event, COUNT(*)::integer AS count, COUNT(DISTINCT e.session_id)::integer AS sessions FROM pedido_eventos e WHERE ${scope.sql} GROUP BY e.event ORDER BY count DESC, e.event`, scope.values),
            this.pool.query(`SELECT lower(COALESCE(e.metadata->>'mode', e.next_state->>'interaction_mode', 'unknown')) AS mode, COUNT(*)::integer AS count FROM pedido_eventos e WHERE ${scope.sql} AND e.event = 'session_mode_selected' GROUP BY 1 ORDER BY 1`, scope.values),
            this.pool.query(`SELECT lower(COALESCE(p.mode, p.modo, 'unknown')) AS mode, COUNT(*)::integer AS count FROM pedidos p WHERE ${this._orderScope(filters).sql} GROUP BY 1 ORDER BY 1`, this._orderScope(filters).values),
        ]);
        const eventRows = safeRows(events).map((row) => ({ event: row.event, count: number(row.count), sessions: number(row.sessions) }));
        const eventCount = (name) => eventRows.find((row) => row.event === name)?.count || 0;
        const started = eventCount('session_started');
        const closed = eventCount('session_closed');
        const modeRows = safeRows(modes).map((row) => ({ mode: row.mode || 'unknown', count: number(row.count) }));
        const orderModeRows = safeRows(orders).map((row) => ({ mode: row.mode || 'unknown', count: number(row.count) }));
        return {
            data_status: eventRows.length ? 'ok' : 'no_data',
            source: 'PostgreSQL.pedido_eventos + pedidos',
            filters: this._filters(filters),
            sessions: {
                started,
                closed,
                recovered: eventCount('session_recovered'),
                timeout_warnings: eventCount('session_timeout_warning'),
                expired: eventCount('session_expired'),
                completion_rate: started ? closed / started : null,
            },
            interaction_modes: modeRows.length ? modeRows : orderModeRows,
            navigation: {
                menu_queries: EVENT_GROUPS.menu_queries.reduce((sum, name) => sum + eventCount(name), 0),
                recommendations: eventCount('recommendation_generated'),
                highlights: eventCount('product_highlighted'),
                ambiguous_references: eventCount('ambiguous_visible_reference'),
            },
            assistance_and_safety: {
                waiter_requests: EVENT_GROUPS.waiter_requests.reduce((sum, name) => sum + eventCount(name), 0),
                safety_warnings: EVENT_GROUPS.safety_warnings.reduce((sum, name) => sum + eventCount(name), 0),
            },
            event_counts: eventRows,
            sample_size: eventRows.reduce((sum, row) => sum + row.count, 0),
            limitations: eventRows.length ? [] : ['No hay eventos HRI en el período seleccionado.'],
        };
    }

    async _latencyMetric(filters, spec) {
        const scope = this._eventScope(filters, [...spec.start, ...spec.end]);
        const result = await this.pool.query(`
            WITH paired AS (
                SELECT e.session_id,
                       MIN(e.timestamp) FILTER (WHERE e.event = ANY(ARRAY[${aliasesForEvent(spec.start)}]::text[])) AS started_at,
                       MIN(e.timestamp) FILTER (WHERE e.event = ANY(ARRAY[${aliasesForEvent(spec.end)}]::text[])) AS finished_at
                  FROM pedido_eventos e
                 WHERE ${scope.sql} AND e.session_id IS NOT NULL
                 GROUP BY e.session_id
            ), durations AS (
                SELECT EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000 AS duration_ms
                  FROM paired
                 WHERE started_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= started_at
            )
            SELECT COUNT(*)::integer AS sample_size,
                   AVG(duration_ms)::numeric AS average_ms,
                   MIN(duration_ms)::numeric AS min_ms,
                   MAX(duration_ms)::numeric AS max_ms,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::numeric AS p50_ms,
                   percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric AS p95_ms
              FROM durations`, scope.values);
        return metricStats(safeRows(result), 5);
    }

    async latency(input = {}) {
        const filters = this._normalize(input);
        const entries = await Promise.all(Object.entries(EVENT_LATENCY_SPECS).map(async ([key, spec]) => [key, await this._latencyMetric(filters, spec)]));
        const metrics = Object.fromEntries(entries);
        return {
            data_status: Object.values(metrics).some((metric) => metric.status === 'ok') ? 'ok' : 'insufficient_data',
            source: 'PostgreSQL.pedido_eventos',
            filters: this._filters(filters),
            metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, metricEnvelope(key === 'order_to_kitchen' ? 'order_to_kitchen_latency' : `${key}_latency`, value, this._filters(filters))])),
            instrumentation: {
                required_events: Object.fromEntries(Object.entries(EVENT_LATENCY_SPECS).map(([key, spec]) => [key, { start: spec.start, end: spec.end }])),
                note: 'Las métricas sin pares persistidos devuelven null; no se sustituyen por ceros sintéticos.',
            },
            limitations: Object.values(metrics).every((metric) => metric.status !== 'ok') ? ['No hay pares de eventos de latencia suficientes en pedido_eventos.'] : [],
        };
    }

    async services(input = {}) {
        const filters = this._normalize(input);
        let snapshot = null;
        if (typeof this.getServiceHealth === 'function') {
            try { snapshot = await this.getServiceHealth(); } catch (error) { snapshot = { status: 'unavailable', error: error.message }; }
        }
        return {
            data_status: snapshot ? 'current_snapshot' : 'insufficient_data',
            source: snapshot ? 'health checks del backend + PostgreSQL' : 'No hay health check persistido de servicios',
            filters: this._filters(filters),
            current: snapshot || {},
            historical: {
                status: 'insufficient_data',
                limitation: 'No se guardan series históricas de disponibilidad/error por servicio en PostgreSQL.',
            },
            sample_size: 0,
            limitations: ['La disponibilidad mostrada es un snapshot actual, no una tasa histórica.'],
        };
    }

    async dataQuality(input = {}) {
        const filters = this._normalize(input);
        const orderScope = this._orderScope(filters, { includeStatus: false, excludeTestLike: false });
        const eventScope = this._eventScope(filters, null, { excludeTestLike: false });
        const [coverageResult, statusResult, temporalResult, orphanResult, eventSourceResult, stageResult, duplicateResult] = await Promise.all([
            this.pool.query(`SELECT COUNT(*)::integer AS total,
                                    COUNT(*) FILTER (WHERE p.created_at IS NULL)::integer AS missing_created_at,
                                    COUNT(*) FILTER (WHERE p.updated_at IS NULL)::integer AS missing_updated_at,
                                    COUNT(*) FILTER (WHERE p.table_id IS NULL AND p.mesa IS NULL)::integer AS missing_table,
                                    COUNT(*) FILTER (WHERE COALESCE(p.items, p.platos, '[]'::jsonb) = '[]'::jsonb)::integer AS missing_items,
                                    COUNT(*) FILTER (WHERE p.data_origin IN ('automated_test','manual_test','seed') AND p.is_test = FALSE)::integer AS untagged_test_origin,
                                    COUNT(*) FILTER (WHERE lower(COALESCE(p.items, p.platos, '[]'::jsonb)::text) ~* '(^|[^a-z])(qa|test|fixture|audit)([^a-z]|$)')::integer AS test_like_unflagged
                               FROM pedidos p WHERE ${orderScope.sql}`, orderScope.values),
            this.pool.query(`SELECT COUNT(*) FILTER (WHERE p.status IS NULL OR NOT (p.status = ANY(${ALL_STATUS_ARRAY_SQL})))::integer AS invalid_status,
                                    COUNT(*) FILTER (WHERE p.status = 'cancelled')::integer AS cancelled,
                                    COUNT(*) FILTER (WHERE p.status = 'draft')::integer AS drafts
                               FROM pedidos p WHERE ${orderScope.sql}`, orderScope.values),
            this.pool.query(`SELECT COUNT(*) FILTER (WHERE p.confirmed_at IS NOT NULL AND p.confirmed_at < p.created_at)::integer AS confirmed_before_created,
                                    COUNT(*) FILTER (WHERE p.delivered_at IS NOT NULL AND p.confirmed_at IS NOT NULL AND p.delivered_at < p.confirmed_at)::integer AS delivered_before_confirmed,
                                    COUNT(*) FILTER (WHERE p.cancelled_at IS NOT NULL AND p.cancelled_at < p.created_at)::integer AS cancelled_before_created
                               FROM pedidos p WHERE ${orderScope.sql}`, orderScope.values),
            this.pool.query(`SELECT COUNT(*)::integer AS orphan_events FROM pedido_eventos e LEFT JOIN pedidos p ON p.id = e.order_id WHERE ${eventScope.sql} AND e.order_id IS NOT NULL AND p.id IS NULL`, eventScope.values),
            this.pool.query(`SELECT COUNT(*) FILTER (WHERE e.source IS NULL OR btrim(e.source) = '')::integer AS events_without_source,
                                    COUNT(*) FILTER (WHERE (lower(COALESCE(e.source, '')) ~* '(^|[^a-z])(qa|test|fixture|audit)([^a-z]|$)'
                                        OR lower(COALESCE(e.metadata->>'source', '')) ~* '(^|[^a-z])(qa|test|fixture|audit)([^a-z]|$)'
                                        OR lower(COALESCE(e.metadata->>'robot_id', '')) ~* '(^|[^a-z])(qa|test|fixture|audit)([^a-z]|$)') AND e.is_test = FALSE)::integer AS test_like_unflagged,
                                    COUNT(*)::integer AS total_events FROM pedido_eventos e WHERE ${eventScope.sql}`, eventScope.values),
            this.pool.query(`SELECT e.event, COUNT(*)::integer AS count FROM pedido_eventos e WHERE ${eventScope.sql} AND e.event = ANY(ARRAY['stt_started','stt_completed','llm_started','llm_completed','tts_started','tts_completed','order_confirmed','kitchen_received','order_sent_to_kitchen']::text[]) GROUP BY e.event ORDER BY e.event`, eventScope.values),
            this.pool.query(`SELECT COUNT(*)::integer AS duplicate_logical_orders FROM (
                                  SELECT p.visit_id, p.order_sequence
                                    FROM pedidos p
                                   WHERE ${orderScope.sql} AND p.visit_id IS NOT NULL AND p.order_sequence IS NOT NULL
                                   GROUP BY p.visit_id, p.order_sequence HAVING COUNT(*) > 1
                               ) duplicates`, orderScope.values),
        ]);
        const coverageRow = coverageResult.rows[0] || {};
        const statusRow = statusResult.rows[0] || {};
        const temporalRow = temporalResult.rows[0] || {};
        const eventSourceRow = eventSourceResult.rows[0] || {};
        const stageCoverage = Object.fromEntries(safeRows(stageResult).map((row) => [row.event, number(row.count)]));
        const issues = [
            ['missing_created_at', number(coverageRow.missing_created_at)],
            ['missing_updated_at', number(coverageRow.missing_updated_at)],
            ['missing_table', number(coverageRow.missing_table)],
            ['missing_items', number(coverageRow.missing_items)],
            ['untagged_test_origin', number(coverageRow.untagged_test_origin)],
            ['test_like_unflagged', number(coverageRow.test_like_unflagged)],
            ['test_like_event_unflagged', number(eventSourceRow.test_like_unflagged)],
            ['invalid_status', number(statusRow.invalid_status)],
            ['confirmed_before_created', number(temporalRow.confirmed_before_created)],
            ['delivered_before_confirmed', number(temporalRow.delivered_before_confirmed)],
            ['cancelled_before_created', number(temporalRow.cancelled_before_created)],
            ['orphan_events', number(orphanResult.rows[0]?.orphan_events)],
            ['events_without_source', number(eventSourceRow.events_without_source)],
            ['duplicate_logical_orders', number(duplicateResult.rows[0]?.duplicate_logical_orders)],
        ].map(([key, count]) => ({ key, count, severity: count > 0 ? (['orphan_events', 'untagged_test_origin', 'test_like_unflagged', 'invalid_status'].includes(key) ? 'high' : 'medium') : 'ok' }));
        return {
            data_status: issues.some((issue) => issue.count > 0) ? 'issues_found' : 'ok',
            source: 'PostgreSQL aggregate data-quality queries',
            filters: this._filters(filters),
            coverage: {
                orders: { total: number(coverageRow.total), missing_created_at: number(coverageRow.missing_created_at), missing_updated_at: number(coverageRow.missing_updated_at), missing_table: number(coverageRow.missing_table), missing_items: number(coverageRow.missing_items), test_like_unflagged: number(coverageRow.test_like_unflagged) },
                events: { total: number(eventSourceRow.total_events), without_source: number(eventSourceRow.events_without_source), test_like_unflagged: number(eventSourceRow.test_like_unflagged) },
            },
            issues,
            instrumentation_coverage: stageCoverage,
            historical_policy: { test_rows_excluded_by_default: !filters.include_test, real_rows_are_not_mutated: true },
            sample_size: number(coverageRow.total),
            limitations: ['Las marcas STT/LLM/TTS y recepción de Cocina no están históricamente instrumentadas en el esquema actual.'],
        };
    }

    async overview(input = {}) {
        const filters = this._normalize(input);
        const [sales, products, tables, operations, hri, delivery, quality] = await Promise.all([
            this.sales(filters),
            this.products(filters),
            this.tables(filters),
            this.operations(filters),
            this.hri(filters),
            this.delivery(filters),
            this.dataQuality(filters),
        ]);
        return {
            data_status: sales.data_status,
            generated_at: this.now().toISOString(),
            source: 'PostgreSQL aggregate SQL',
            filters: this._filters(filters),
            sales: sales.kpis,
            top_products: products.top_products,
            categories: products.categories,
            tables: tables.snapshot,
            operations: operations.kitchen,
            hri: hri.sessions,
            delivery: delivery.mode,
            data_quality: { status: quality.data_status, issue_count: quality.issues.filter((issue) => issue.count > 0).length },
            limitations: [...new Set([...sales.limitations, ...products.limitations, ...tables.limitations, ...operations.limitations, ...hri.limitations, ...delivery.limitations, ...quality.limitations])],
            sample_size: sales.sample_size,
        };
    }

    async exportDataset(dataset, input = {}) {
        const name = String(dataset || '').trim().toLowerCase();
        const allowed = new Set(['overview', 'sales', 'products', 'tables', 'operations', 'hri', 'latency', 'services', 'data-quality', 'dictionary', 'delivery']);
        if (!allowed.has(name)) throw new AnalyticsQueryError('dataset no está permitido.', 'INVALID_ANALYTICS_DATASET');
        const method = name === 'data-quality' ? 'dataQuality' : name;
        const data = await this[method](input);
        return { dataset: name, exported_at: this.now().toISOString(), data };
    }
}

export { EVENT_LATENCY_SPECS, EVENT_GROUPS, statusForSample, coverage };
