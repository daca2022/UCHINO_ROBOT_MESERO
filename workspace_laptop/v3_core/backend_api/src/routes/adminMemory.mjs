import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.mjs';

export function createAdminMemoryRouter(memoryService) {
    const router = Router();
    router.use(adminAuth);

    router.get('/summary', async (_req, res) => res.json(await memoryService.adminSnapshot()));

    router.get('/settings', async (_req, res) => res.json(await memoryService.getPolicy()));

    router.patch('/settings', async (req, res) => {
        try {
            const result = await memoryService.setPolicy({ retentionPolicy: req.body?.retention_policy, actor: req.adminUser?.sub || req.adminUser?.user || 'admin' });
            return res.json({ ok: true, ...result });
        } catch (error) {
            return res.status(error.code === 'INVALID_RETENTION_POLICY' ? 400 : 500).json({ error: error.message, code: error.code || 'MEMORY_SETTINGS_ERROR' });
        }
    });

    router.post('/cleanup', async (req, res) => {
        try { return res.json({ ok: true, ...(await memoryService.cleanupExpired({ source: 'admin', actor: req.adminUser?.sub || 'admin' })) }); }
        catch (error) {
            await memoryService.recordCleanupFailure?.({ source: 'admin', actor: req.adminUser?.sub || 'admin', error });
            return res.status(500).json({ error: error.message, code: 'MEMORY_CLEANUP_ERROR' });
        }
    });

    router.get('/profiles', async (req, res) => {
        const data = await memoryService.listProfiles({ limit: req.query.limit });
        return res.json({ data, count: data.length });
    });

    router.get('/profiles/:id', async (req, res) => {
        try {
            const profile = await memoryService.getProfileForAdmin(req.params.id);
            if (!profile) return res.status(404).json({ error: 'Perfil no encontrado', code: 'PROFILE_NOT_FOUND' });
            return res.json(profile);
        } catch (error) { return res.status(400).json({ error: error.message, code: error.code || 'PROFILE_ERROR' }); }
    });

    router.delete('/profiles/:id', async (req, res) => {
        try {
            if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm=true es obligatorio', code: 'CONFIRMATION_REQUIRED' });
            return res.json({ ok: true, ...(await memoryService.adminForget({ profileId: req.params.id, scope: req.body?.scope || 'all', actor: req.adminUser?.sub || 'admin' })) });
        } catch (error) {
            const status = ['PROFILE_ID_REQUIRED', 'INVALID_FORGET_SCOPE', 'PROFILE_NOT_FOUND'].includes(error.code) ? 400 : 500;
            return res.status(status).json({ error: error.message, code: error.code || 'PROFILE_FORGET_ERROR' });
        }
    });

    router.post('/profiles/:id/anonymize', async (req, res) => {
        try {
            if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm=true es obligatorio', code: 'CONFIRMATION_REQUIRED' });
            return res.json({ ok: true, ...(await memoryService.anonymizeProfile({ profileId: req.params.id, actor: req.adminUser?.sub || 'admin' })) });
        } catch (error) {
            const status = ['PROFILE_ID_REQUIRED', 'PROFILE_NOT_FOUND'].includes(error.code) ? 400 : 500;
            return res.status(status).json({ error: error.message, code: error.code || 'PROFILE_ANONYMIZE_ERROR' });
        }
    });

    router.get('/audit', async (req, res) => res.json({ data: await memoryService.audit({ limit: req.query.limit }), source: 'memory_audit_events' }));
    return router;
}
