const VALID_TIMEZONES = new Set([
    'America/Lima',
    'UTC',
    'America/Bogota',
    'America/Santiago',
    'America/Mexico_City',
    'America/New_York',
    'Europe/Madrid',
]);

export const ANALYTICS_TIMEZONE = 'America/Lima';
export const ANALYTICS_MAX_DAYS = 366;

export const SALE_STATUSES = Object.freeze([
    'confirmed',
    'sent_to_kitchen',
    'preparing',
    'ready',
    'delivery_in_progress',
    'delivered',
]);

export const ALL_ORDER_STATUSES = Object.freeze([
    'draft',
    'pending_confirmation',
    'provisional',
    ...SALE_STATUSES,
    'cancelled',
    'closed',
]);

export const DELIVERY_MODES = Object.freeze(['all', 'real', 'simulated']);

export const ANALYTICS_METRIC_DICTIONARY = Object.freeze({
    valid_orders: {
        label: 'Pedidos válidos',
        unit: 'orders',
        formula: 'COUNT(pedidos) con estado confirmado o posterior, deleted_at nulo',
        source: 'PostgreSQL.pedidos',
        exclusions: ['draft', 'pending_confirmation', 'provisional', 'cancelled', 'closed', 'is_test por defecto', 'patrones QA/test no etiquetados'],
        minimum_sample: 1,
    },
    sales_total: {
        label: 'Ventas totales',
        unit: 'PEN',
        formula: 'SUM(pedidos.total) de pedidos válidos',
        source: 'PostgreSQL.pedidos.total',
        exclusions: ['pedidos no válidos', 'deleted_at no nulo', 'is_test por defecto', 'patrones QA/test no etiquetados'],
        minimum_sample: 1,
    },
    average_ticket: {
        label: 'Ticket promedio',
        unit: 'PEN/order',
        formula: 'SUM(total) / COUNT(pedidos válidos)',
        source: 'PostgreSQL.pedidos.total',
        exclusions: ['pedidos no válidos', 'totales nulos'],
        minimum_sample: 1,
    },
    product_units: {
        label: 'Unidades por producto',
        unit: 'units',
        formula: 'SUM(item.cantidad) sobre items JSONB de pedidos válidos',
        source: 'PostgreSQL.pedidos.items/platos',
        exclusions: ['líneas sin nombre', 'pedidos no válidos', 'is_test por defecto', 'patrones QA/test no etiquetados'],
        minimum_sample: 1,
    },
    occupancy: {
        label: 'Ocupación de mesas',
        unit: 'percentage',
        formula: 'mesas ocupadas / mesas habilitadas en el snapshot actual',
        source: 'PostgreSQL.restaurant_tables',
        exclusions: ['mesas disabled'],
        minimum_sample: 1,
    },
    session_completion_rate: {
        label: 'Tasa de cierre de sesiones',
        unit: 'percentage',
        formula: 'session_closed / session_started en pedido_eventos',
        source: 'PostgreSQL.pedido_eventos',
        exclusions: ['is_test por defecto', 'patrones QA/test no etiquetados', 'sesiones sin evento'],
        minimum_sample: 5,
    },
    order_to_kitchen_latency: {
        label: 'Pedido a Cocina',
        unit: 'milliseconds',
        formula: 'timestamp de recepción en Cocina - timestamp de confirmación',
        source: 'pedido_eventos; requiere ambos eventos instrumentados',
        exclusions: ['pares incompletos'],
        minimum_sample: 5,
    },
    stt_latency: {
        label: 'Latencia STT',
        unit: 'milliseconds',
        formula: 'fin STT - inicio STT',
        source: 'pedido_eventos; requiere eventos stt_started/stt_completed',
        exclusions: ['pares incompletos'],
        minimum_sample: 5,
    },
    llm_latency: {
        label: 'Latencia LLM',
        unit: 'milliseconds',
        formula: 'fin LLM - inicio LLM',
        source: 'pedido_eventos; requiere eventos llm_started/llm_completed',
        exclusions: ['pares incompletos'],
        minimum_sample: 5,
    },
    tts_latency: {
        label: 'Latencia TTS',
        unit: 'milliseconds',
        formula: 'fin TTS - inicio TTS',
        source: 'pedido_eventos; requiere eventos tts_started/tts_completed',
        exclusions: ['pares incompletos'],
        minimum_sample: 5,
    },
});

export class AnalyticsQueryError extends Error {
    constructor(message, code = 'INVALID_ANALYTICS_QUERY', status = 400, details = undefined) {
        super(message);
        this.name = 'AnalyticsQueryError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function first(value) {
    return Array.isArray(value) ? value[0] : value;
}

function parseBoolean(value, field, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = String(first(value)).trim().toLowerCase();
    if (['true', '1', 'yes', 'si'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
    throw new AnalyticsQueryError(`${field} debe ser booleano.`, 'INVALID_ANALYTICS_BOOLEAN');
}

function getLocalParts(date, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    return Object.fromEntries(formatter.formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]));
}

function localDateKey(date, timeZone) {
    const parts = getLocalParts(date, timeZone);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function addLocalDays(dateKey, days) {
    const [year, month, day] = dateKey.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return date.toISOString().slice(0, 10);
}

function localDateTimeToUtc(dateKey, timeZone) {
    const [year, month, day] = dateKey.split('-').map(Number);
    let candidate = Date.UTC(year, month - 1, day, 0, 0, 0);
    for (let iteration = 0; iteration < 4; iteration += 1) {
        const parts = getLocalParts(new Date(candidate), timeZone);
        const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
        const desired = Date.UTC(year, month - 1, day, 0, 0, 0);
        candidate += desired - asUtc;
    }
    return new Date(candidate);
}

function assertDateKey(value, field) {
    const raw = String(first(value) || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(raw)) {
        throw new AnalyticsQueryError(`${field} debe tener formato YYYY-MM-DD.`, 'INVALID_ANALYTICS_DATE');
    }
    const date = new Date(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
        throw new AnalyticsQueryError(`${field} no es una fecha válida.`, 'INVALID_ANALYTICS_DATE');
    }
    return raw;
}

function normalizeTable(value) {
    if (value === undefined || value === null || value === '') return null;
    const raw = String(first(value)).trim().toUpperCase().replace(/^MESA\s*/u, '').replace(/^M(?=\d)/u, '');
    if (!/^([1-9]|1[0-2])$/u.test(raw)) {
        throw new AnalyticsQueryError('table_id debe estar entre M1 y M12.', 'INVALID_ANALYTICS_TABLE');
    }
    return `M${Number(raw)}`;
}

function normalizeString(value, field, maxLength = 80) {
    if (value === undefined || value === null || value === '') return null;
    const normalized = String(first(value)).trim();
    if (!normalized || normalized.length > maxLength || /[;\\x00]/u.test(normalized)) {
        throw new AnalyticsQueryError(`${field} no es válido.`, 'INVALID_ANALYTICS_FILTER');
    }
    return normalized;
}

function resolvePeriod(input, now, timeZone) {
    const fromInput = first(input.date_from ?? input.from);
    const toInput = first(input.date_to ?? input.to);
    const preset = String(first(input.period ?? input.date_preset ?? 'today') || 'today').trim().toLowerCase();
    const localToday = localDateKey(now, timeZone);
    let fromKey = null;
    let toKey = null;
    if (fromInput || toInput) {
        fromKey = assertDateKey(fromInput || localToday, 'date_from');
        toKey = assertDateKey(toInput || addLocalDays(fromKey, 1), 'date_to');
        if (toKey <= fromKey) throw new AnalyticsQueryError('date_from debe ser anterior a date_to.', 'INVALID_ANALYTICS_DATE_RANGE');
    } else if (['today', 'hoy'].includes(preset)) {
        fromKey = localToday;
        toKey = addLocalDays(fromKey, 1);
    } else if (['yesterday', 'ayer'].includes(preset)) {
        toKey = localToday;
        fromKey = addLocalDays(toKey, -1);
    } else if (['last7', 'last_7_days', '7d', 'ultimos_7_dias'].includes(preset)) {
        toKey = addLocalDays(localToday, 1);
        fromKey = addLocalDays(toKey, -7);
    } else if (['last30', 'last_30_days', '30d', 'ultimos_30_dias'].includes(preset)) {
        toKey = addLocalDays(localToday, 1);
        fromKey = addLocalDays(toKey, -30);
    } else if (['current_week', 'week', 'semana_actual'].includes(preset)) {
        const day = new Date(`${localToday}T00:00:00.000Z`).getUTCDay();
        const mondayOffset = day === 0 ? -6 : 1 - day;
        fromKey = addLocalDays(localToday, mondayOffset);
        toKey = addLocalDays(fromKey, 7);
    } else if (['current_month', 'month', 'mes_actual'].includes(preset)) {
        fromKey = `${localToday.slice(0, 7)}-01`;
        const [year, month] = fromKey.split('-').map(Number);
        toKey = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    } else if (['current_year', 'year', 'ano_actual', 'año_actual'].includes(preset)) {
        fromKey = `${localToday.slice(0, 4)}-01-01`;
        toKey = `${Number(localToday.slice(0, 4)) + 1}-01-01`;
    } else {
        throw new AnalyticsQueryError('El período solicitado no está soportado.', 'INVALID_ANALYTICS_PERIOD');
    }
    const from = localDateTimeToUtc(fromKey, timeZone);
    const to = localDateTimeToUtc(toKey, timeZone);
    const days = Math.ceil((to.getTime() - from.getTime()) / 86400000);
    if (days > ANALYTICS_MAX_DAYS) {
        throw new AnalyticsQueryError(`El rango máximo es de ${ANALYTICS_MAX_DAYS} días.`, 'ANALYTICS_RANGE_TOO_LARGE');
    }
    return {
        preset,
        from: from.toISOString(),
        to: to.toISOString(),
        from_local: fromKey,
        to_local_exclusive: toKey,
        days,
    };
}

export function normalizeAnalyticsQuery(input = {}, { now = new Date() } = {}) {
    const requestedZone = normalizeString(input.timezone ?? input.tz ?? ANALYTICS_TIMEZONE, 'timezone', 64) || ANALYTICS_TIMEZONE;
    let timeZone = requestedZone;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format(now);
    } catch {
        throw new AnalyticsQueryError('timezone no es compatible con IANA.', 'INVALID_ANALYTICS_TIMEZONE');
    }
    if (!VALID_TIMEZONES.has(timeZone) && !timeZone.includes('/')) {
        throw new AnalyticsQueryError('timezone no es compatible con IANA.', 'INVALID_ANALYTICS_TIMEZONE');
    }
    const period = resolvePeriod(input, now, timeZone);
    const category = normalizeString(input.category ?? input.categoria, 'category', 60)?.toLowerCase() || null;
    const interactionMode = normalizeString(input.interaction_mode ?? input.mode, 'interaction_mode', 40)?.toLowerCase() || null;
    const deliveryMode = String(first(input.delivery_mode ?? 'all') || 'all').trim().toLowerCase();
    if (!DELIVERY_MODES.includes(deliveryMode)) {
        throw new AnalyticsQueryError('delivery_mode debe ser all, real o simulated.', 'INVALID_DELIVERY_MODE');
    }
    const granularity = String(first(input.granularity || 'day')).trim().toLowerCase();
    if (!['day', 'week', 'month'].includes(granularity)) {
        throw new AnalyticsQueryError('granularity debe ser day, week o month.', 'INVALID_GRANULARITY');
    }
    const includeTest = parseBoolean(input.include_test, 'include_test', false);
    const diagnostic = parseBoolean(input.diagnostic, 'diagnostic', false);
    return {
        timezone: timeZone,
        period,
        table_id: normalizeTable(input.table_id ?? input.table ?? input.mesa),
        category,
        interaction_mode: interactionMode,
        delivery_mode: deliveryMode,
        include_test: includeTest,
        diagnostic,
        granularity,
    };
}

export function previousPeriod(period) {
    const duration = new Date(period.to).getTime() - new Date(period.from).getTime();
    return {
        from: new Date(new Date(period.from).getTime() - duration).toISOString(),
        to: period.from,
    };
}

export function localizeMetricDictionary() {
    return Object.fromEntries(Object.entries(ANALYTICS_METRIC_DICTIONARY).map(([key, value]) => [key, { key, ...value }]));
}
