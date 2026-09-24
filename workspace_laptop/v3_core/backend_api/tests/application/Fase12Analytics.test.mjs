import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ANALYTICS_METRIC_DICTIONARY,
    AnalyticsQueryError,
    normalizeAnalyticsQuery,
    previousPeriod,
} from '../../src/application/AnalyticsMetricDefinitions.mjs';
import { AnalyticsService } from '../../src/application/AnalyticsService.mjs';

const FIXED_NOW = new Date('2026-08-01T15:00:00.000Z');

test('Fase12 normaliza hoy con America/Lima y rango semiabierto', () => {
    const query = normalizeAnalyticsQuery({ period: 'today', timezone: 'America/Lima' }, { now: FIXED_NOW });
    assert.equal(query.timezone, 'America/Lima');
    assert.equal(query.period.from_local, '2026-08-01');
    assert.equal(query.period.to_local_exclusive, '2026-08-02');
    assert.equal(query.period.from, '2026-08-01T05:00:00.000Z');
    assert.equal(query.period.to, '2026-08-02T05:00:00.000Z');
});

test('Fase12 acepta filtros seguros y excluye test por defecto', () => {
    const query = normalizeAnalyticsQuery({ period: 'last7', table_id: 'mesa 8', category: ' Bebida ', interaction_mode: 'screen', delivery_mode: 'simulated', diagnostic: 'true' }, { now: FIXED_NOW });
    assert.equal(query.table_id, 'M8');
    assert.equal(query.category, 'bebida');
    assert.equal(query.interaction_mode, 'screen');
    assert.equal(query.delivery_mode, 'simulated');
    assert.equal(query.include_test, false);
    assert.equal(query.diagnostic, true);
});

test('Fase12 rechaza rangos, mesas y zonas inválidas', () => {
    assert.throws(() => normalizeAnalyticsQuery({ table_id: 'M99' }, { now: FIXED_NOW }), AnalyticsQueryError);
    assert.throws(() => normalizeAnalyticsQuery({ timezone: 'not-a-zone' }, { now: FIXED_NOW }), AnalyticsQueryError);
    assert.throws(() => normalizeAnalyticsQuery({ date_from: '2026-08-03', date_to: '2026-08-02' }, { now: FIXED_NOW }), AnalyticsQueryError);
});

test('Fase12 calcula período anterior sin datos sintéticos', () => {
    const query = normalizeAnalyticsQuery({ period: 'last7' }, { now: FIXED_NOW });
    const previous = previousPeriod(query.period);
    assert.equal(new Date(previous.to).getTime(), new Date(query.period.from).getTime());
    assert.equal(new Date(previous.to).getTime() - new Date(previous.from).getTime(), 7 * 86400000);
});

test('Fase12 expone diccionario con fuentes y regla no-data', async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const service = new AnalyticsService({ pool, now: () => FIXED_NOW });
    const dictionary = await service.dictionary();
    assert.equal(dictionary.rules.no_data_is_not_zero, true);
    assert.match(dictionary.rules.test_exclusion, /QA\/test/u);
    assert.equal(dictionary.metrics.sales_total.source, ANALYTICS_METRIC_DICTIONARY.sales_total.source);
    assert.ok(dictionary.metrics.order_to_kitchen_latency.minimum_sample >= 5);
});

test('Fase12 construye scope agregado sin interpolar filtros del usuario', () => {
    const pool = { query: async () => ({ rows: [] }) };
    const service = new AnalyticsService({ pool, now: () => FIXED_NOW });
    const filters = service.normalize({ period: 'today', table_id: 'M8', category: 'bebida' });
    const scope = service._orderScope(filters);
    assert.match(scope.sql, /p\.created_at >= \$1/u);
    assert.match(scope.sql, /p\.status = ANY\(ARRAY\[/u);
    assert.equal(scope.values.at(-1), 'bebida');
    assert.equal(scope.sql.includes('bebida'), false);
});

test('Fase12 auditoría no guarda texto libre de consultas', async () => {
    const calls = [];
    const pool = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
    const service = new AnalyticsService({ pool, now: () => FIXED_NOW });
    const filters = service.normalize({ period: 'today', table_id: 'M8' });
    await service.recordAudit({ dataset: 'sales', filters, actor: 'admin' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].values[0], 'analytics_viewed');
    assert.match(calls[0].values[2], /M8/u);
    assert.equal(calls[0].values[2].includes('nombre'), false);
});
