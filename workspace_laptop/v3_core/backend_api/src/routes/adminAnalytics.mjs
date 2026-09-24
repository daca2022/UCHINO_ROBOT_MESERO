import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { adminAuth } from '../middleware/adminAuth.mjs';
import { AnalyticsQueryError } from '../application/AnalyticsMetricDefinitions.mjs';

const DATASETS = Object.freeze(['overview', 'sales', 'products', 'tables', 'operations', 'hri', 'latency', 'services', 'data-quality', 'delivery', 'dictionary']);

function first(value) {
    return Array.isArray(value) ? value[0] : value;
}

function queryInput(req) {
    const input = { ...req.query };
    if (String(first(input.include_test) || '').toLowerCase() === 'true' && String(first(input.diagnostic) || '').toLowerCase() !== 'true') {
        throw new AnalyticsQueryError('include_test requiere diagnostic=true y autorización Admin.', 'ANALYTICS_DIAGNOSTIC_REQUIRED', 403);
    }
    return input;
}

function csvCell(value) {
    const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${text.replaceAll('"', '""')}"`;
}

function flattenForCsv(dataset, payload) {
    const data = payload?.data || payload;
    const records = Array.isArray(data?.products) ? data.products
        : Array.isArray(data?.series) ? data.series
            : Array.isArray(data?.visits) ? data.visits
                : Array.isArray(data?.event_counts) ? data.event_counts
                    : Array.isArray(data?.issues) ? data.issues
                        : Array.isArray(data?.categories) ? data.categories
                            : [{ dataset, ...data }];
    const keys = [...new Set(records.flatMap((record) => Object.keys(record || {})))];
    return [
        keys.map(csvCell).join(','),
        ...records.map((record) => keys.map((key) => csvCell(record?.[key])).join(',')),
    ].join('\n');
}

export function createAdminAnalyticsRouter(analyticsService) {
    if (!analyticsService) throw new Error('AnalyticsService requerido');
    const router = Router();
    const lastRequest = new Map();
    const RATE_LIMIT_WINDOW_MS = 150;
    const RATE_LIMIT_RETENTION_MS = 60_000;
    const RATE_LIMIT_MAX_ENTRIES = 2_048;

    function allowRequest(req, dataset) {
        const key = `${req.adminUser?.user || 'admin'}:${dataset}`;
        const now = Date.now();
        for (const [entryKey, timestamp] of lastRequest) {
            if (now - timestamp >= RATE_LIMIT_RETENTION_MS) lastRequest.delete(entryKey);
        }
        while (lastRequest.size >= RATE_LIMIT_MAX_ENTRIES) {
            const oldestKey = lastRequest.keys().next().value;
            if (oldestKey === undefined) break;
            lastRequest.delete(oldestKey);
        }
        if (now - (lastRequest.get(key) || 0) < RATE_LIMIT_WINDOW_MS) return false;
        lastRequest.set(key, now);
        return true;
    }

    router.use(adminAuth);

    async function audit(req, dataset, input, result = 'ok') {
        try {
            const filters = analyticsService.normalize(input);
            await analyticsService.recordAudit({
                event: String(input.refresh || '').toLowerCase() === 'true' ? 'analytics_refresh_requested' : 'analytics_viewed',
                actor: req.adminUser?.user || 'admin',
                dataset,
                filters,
                result,
            });
        } catch (error) {
            // La auditoría no debe convertir una consulta de solo lectura en una mutación fallida.
            if (!(error instanceof AnalyticsQueryError)) analyticsService.logger?.warn?.('[Analytics] audit skipped:', error.message);
        }
    }

    async function execute(req, res, dataset, method) {
        const traceId = randomUUID();
        let input;
        try {
            input = queryInput(req);
        } catch (error) {
            return res.status(error.status || 400).json({ error: error.message, code: error.code, trace_id: traceId });
        }
        if (!allowRequest(req, dataset)) {
            return res.status(429).json({ error: 'Consulta analítica demasiado frecuente.', code: 'ANALYTICS_RATE_LIMITED', trace_id: traceId });
        }
        try {
            const data = await analyticsService[method](input);
            await audit(req, dataset, input);
            return res.json({ ...data, trace_id: traceId });
        } catch (error) {
            await audit(req, dataset, req.query, error.code || 'error');
            if (error instanceof AnalyticsQueryError || error.code?.startsWith('INVALID_') || error.code?.startsWith('ANALYTICS_')) {
                return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details, trace_id: traceId });
            }
            analyticsService.logger?.error?.('[Analytics] query failed:', error.message);
            return res.status(503).json({ error: 'La analítica no está disponible temporalmente.', code: 'ANALYTICS_UNAVAILABLE', trace_id: traceId });
        }
    }

    router.get('/dictionary', (req, res) => execute(req, res, 'dictionary', 'dictionary'));
    router.get('/overview', (req, res) => execute(req, res, 'overview', 'overview'));
    router.get('/sales', (req, res) => execute(req, res, 'sales', 'sales'));
    router.get('/products', (req, res) => execute(req, res, 'products', 'products'));
    router.get('/tables', (req, res) => execute(req, res, 'tables', 'tables'));
    router.get('/operations', (req, res) => execute(req, res, 'operations', 'operations'));
    router.get('/hri', (req, res) => execute(req, res, 'hri', 'hri'));
    router.get('/latency', (req, res) => execute(req, res, 'latency', 'latency'));
    router.get('/services', (req, res) => execute(req, res, 'services', 'services'));
    router.get('/data-quality', (req, res) => execute(req, res, 'data-quality', 'dataQuality'));
    router.get('/delivery', (req, res) => execute(req, res, 'delivery', 'delivery'));

    router.get('/export', async (req, res) => {
        const dataset = String(first(req.query.dataset || '')).trim().toLowerCase();
        const format = String(first(req.query.format || 'json')).trim().toLowerCase();
        if (!DATASETS.includes(dataset)) return res.status(400).json({ error: 'dataset no está permitido.', code: 'INVALID_ANALYTICS_DATASET' });
        if (!['json', 'csv'].includes(format)) return res.status(400).json({ error: 'format debe ser json o csv.', code: 'INVALID_ANALYTICS_FORMAT' });
        const traceId = randomUUID();
        try {
            const input = queryInput(req);
            if (!allowRequest(req, dataset)) {
                return res.status(429).json({ error: 'Consulta analítica demasiado frecuente.', code: 'ANALYTICS_RATE_LIMITED', trace_id: traceId });
            }
            const payload = await analyticsService.exportDataset(dataset, input);
            await audit(req, dataset, input, 'exported');
            if (format === 'csv') {
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="uchino-analytics-${dataset}.csv"`);
                return res.send(`dataset,generated_at\n${csvCell(dataset)},${csvCell(payload.exported_at)}\n\n${flattenForCsv(dataset, payload.data)}`);
            }
            return res.json({ ...payload, trace_id: traceId });
        } catch (error) {
            await audit(req, dataset, req.query, error.code || 'error');
            if (error instanceof AnalyticsQueryError || error.code?.startsWith('INVALID_') || error.code?.startsWith('ANALYTICS_')) {
                return res.status(error.status || 400).json({ error: error.message, code: error.code, trace_id: traceId });
            }
            analyticsService.logger?.error?.('[Analytics] export failed:', error.message);
            return res.status(503).json({ error: 'La exportación no está disponible temporalmente.', code: 'ANALYTICS_EXPORT_UNAVAILABLE', trace_id: traceId });
        }
    });

    return router;
}

export { DATASETS, flattenForCsv };
