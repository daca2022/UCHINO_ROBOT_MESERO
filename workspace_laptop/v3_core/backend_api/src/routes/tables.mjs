import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.mjs';

function errorStatus(error) {
    if (['TABLE_OCCUPIED', 'NO_ACTIVE_VISIT', 'ADDITIONAL_ORDERS_DISABLED', 'TABLE_DISABLED', 'VISIT_NOT_FOUND', 'ROBOT_BUSY', 'TABLE_CONFLICT', 'STALE_VISIT', 'TABLE_ACTIVE'].includes(error.code)) return 409;
    if (['INVALID_TABLE', 'INVALID_GUEST_COUNT'].includes(error.code)) return 400;
    return 500;
}

export function createTablesRouter(tableService) {
    const router = Router();
    router.use(adminAuth);

    router.get('/', async (req, res) => {
        try {
            const data = await tableService.listTables({
                status: req.query.status || null,
                enabled: req.query.enabled === undefined ? null : req.query.enabled === 'true',
            });
            res.json({ data, count: data.length, table_ids: data.map(table => table.table_id) });
        } catch (error) {
            res.status(errorStatus(error)).json({ error: error.message, code: error.code || 'TABLES_ERROR' });
        }
    });

    router.get('/:tableId', async (req, res) => {
        try {
            const table = await tableService.getTable(req.params.tableId);
            if (!table) return res.status(404).json({ error: 'Mesa no encontrada', code: 'TABLE_NOT_FOUND' });
            res.json(table);
        } catch (error) {
            res.status(errorStatus(error)).json({ error: error.message, code: error.code || 'TABLE_ERROR' });
        }
    });

    router.get('/:tableId/history', async (req, res) => {
        try {
            const page = await tableService.historyPage(req.params.tableId, req.query);
            res.json(page);
        } catch (error) {
            res.status(errorStatus(error)).json({ error: error.message, code: error.code || 'HISTORY_ERROR' });
        }
    });

    router.get('/:tableId/visits/:visitId', async (req, res) => {
        try {
            const visit = await tableService.getVisit(req.params.tableId, req.params.visitId);
            if (!visit) return res.status(404).json({ error: 'Visita no encontrada', code: 'VISIT_NOT_FOUND' });
            res.json(visit);
        } catch (error) {
            res.status(errorStatus(error)).json({ error: error.message, code: error.code || 'VISIT_ERROR' });
        }
    });

    router.post('/:tableId/visits/start', adminAuth, async (req, res) => {
        try {
            const result = await tableService.startVisit({
                tableId: req.params.tableId,
                robotId: req.body?.robot_id || 'uchino-01',
                source: req.body?.source || 'robot_screen',
                guestCount: req.body?.guest_count,
            });
            res.status(201).json(result);
        } catch (error) {
            res.status(errorStatus(error)).json({ error: error.message, code: error.code || 'VISIT_START_ERROR', visit_id: error.visit_id || null });
        }
    });

    router.post('/:tableId/visits/additional', adminAuth, async (req, res) => {
        try {
            const result = await tableService.startAdditionalOrder({
                tableId: req.params.tableId,
                robotId: req.body?.robot_id || 'uchino-01',
                source: req.body?.source || 'robot_screen',
                guestCount: req.body?.guest_count,
            });
            res.status(201).json(result);
        } catch (error) {
            res.status(errorStatus(error)).json({ error: error.message, code: error.code || 'ADDITIONAL_ORDER_ERROR', visit_id: error.visit_id || null });
        }
    });

    router.post('/:tableId/visits/:visitId/continue', adminAuth, async (req, res) => {
        try {
            const result = await tableService.continueVisit({
                tableId: req.params.tableId,
                visitId: req.params.visitId,
                robotId: req.body?.robot_id || 'uchino-01',
                source: req.body?.source || 'robot_screen',
                guestCount: req.body?.guest_count,
            });
            res.json(result);
        } catch (error) {
            res.status(errorStatus(error)).json({ error: error.message, code: error.code || 'CONTINUE_VISIT_ERROR' });
        }
    });

    return router;
}
