import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.mjs';
import { OrderHistoryError } from '../application/OrderHistoryService.mjs';

function actorOf(req) {
    return req.adminUser?.user || req.adminUser?.sub || 'admin';
}

function sendError(res, error) {
    const status = error instanceof OrderHistoryError
        ? error.status
        : (['ORDER_NOT_FOUND', 'VISIT_NOT_FOUND'].includes(error.code) ? 404 : 500);
    return res.status(status).json({ error: error.message || 'Error de historial', code: error.code || 'ORDER_HISTORY_ERROR', details: error.details || undefined });
}

export function createAdminHistoryRouter(historyService) {
    const router = Router();
    router.use(adminAuth);

    router.get('/orders/export', async (req, res) => {
        try {
            const format = req.query.format === 'json' ? 'json' : 'csv';
            const data = await historyService.exportOrders(req.query, { actor: actorOf(req), format });
            if (format === 'json') return res.json(data);
            res.setHeader('Content-Disposition', `attachment; filename="uchino-pedidos-${new Date().toISOString().slice(0, 10)}.csv"`);
            res.type('text/csv; charset=utf-8');
            return res.send(data);
        } catch (error) { return sendError(res, error); }
    });

    router.get('/orders/summary', async (req, res) => {
        try { return res.json(await historyService.summary({ actor: actorOf(req) })); }
        catch (error) { return sendError(res, error); }
    });

    router.get('/orders/audit', async (req, res) => {
        try { return res.json(await historyService.audit({ ...req.query, actor: actorOf(req) })); }
        catch (error) { return sendError(res, error); }
    });

    router.get('/orders', async (req, res) => {
        try { return res.json(await historyService.listOrders(req.query, { actor: actorOf(req) })); }
        catch (error) { return sendError(res, error); }
    });

    router.get('/orders/:id', async (req, res) => {
        try {
            const order = await historyService.getOrder(req.params.id);
            if (!order) return res.status(404).json({ error: 'Pedido no encontrado', code: 'ORDER_NOT_FOUND' });
            return res.json(order);
        } catch (error) { return sendError(res, error); }
    });

    router.post('/orders/:id/archive', async (req, res) => {
        try {
            return res.json(await historyService.archiveOrder(req.params.id, {
                actor: actorOf(req),
                reason: req.body?.reason,
            }));
        } catch (error) { return sendError(res, error); }
    });

    router.post('/orders/:id/unarchive', async (req, res) => {
        try {
            return res.json(await historyService.unarchiveOrder(req.params.id, {
                actor: actorOf(req),
                reason: req.body?.reason,
            }));
        } catch (error) { return sendError(res, error); }
    });

    router.delete('/orders/:id', async (req, res) => {
        try {
            return res.json(await historyService.deleteOrder(req.params.id, {
                actor: actorOf(req),
                reason: req.body?.reason,
                confirm: req.body?.confirm === true,
            }));
        } catch (error) { return sendError(res, error); }
    });

    router.get('/retention/policy', async (req, res) => {
        try { return res.json(await historyService.getRetentionPolicy()); }
        catch (error) { return sendError(res, error); }
    });

    router.put('/retention/policy', async (req, res) => {
        try {
            return res.json(await historyService.updateRetentionPolicy(req.body || {}, { actor: actorOf(req), reason: req.body?.reason || 'policy_update' }));
        } catch (error) { return sendError(res, error); }
    });

    router.post('/retention/preview', async (req, res) => {
        try { return res.json(await historyService.previewCleanup({ kind: req.body?.kind || 'maintenance', actor: actorOf(req) })); }
        catch (error) { return sendError(res, error); }
    });

    router.post('/retention/execute', async (req, res) => {
        try {
            return res.json(await historyService.executeCleanup({
                previewToken: req.body?.preview_token,
                actor: actorOf(req),
                confirm: req.body?.confirm === true,
                reason: req.body?.reason,
            }));
        } catch (error) { return sendError(res, error); }
    });

    router.post('/test-data/preview', async (req, res) => {
        try { return res.json(await historyService.previewCleanup({ kind: 'test', actor: actorOf(req) })); }
        catch (error) { return sendError(res, error); }
    });

    router.post('/test-data/cleanup', async (req, res) => {
        try {
            return res.json(await historyService.executeCleanup({
                previewToken: req.body?.preview_token,
                actor: actorOf(req),
                confirm: req.body?.confirm === true,
                reason: req.body?.reason,
            }));
        } catch (error) { return sendError(res, error); }
    });

    router.get('/visits/:visitId/history', async (req, res) => {
        try { return res.json(await historyService.visitHistory(req.params.visitId, req.query, { actor: actorOf(req) })); }
        catch (error) { return sendError(res, error); }
    });

    return router;
}
