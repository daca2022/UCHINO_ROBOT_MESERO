import { Router } from 'express';
import { normalizeConsent, normalizeRetentionPolicy } from '../../../memory_db/src/services/TemporaryMemoryService.mjs';

function sessionOrError(orderSessionManager, sessionId, req = null) {
    const session = orderSessionManager.get(sessionId);
    if (!session) {
        const error = new Error('Sesión no encontrada.');
        error.code = 'SESSION_NOT_FOUND';
        throw error;
    }
    if (['closed', 'expired', 'completing'].includes(session.session_status)) {
        const error = new Error(`Sesión ${session.session_status}.`);
        error.code = 'STALE_SESSION';
        throw error;
    }
    if (req) {
        const providedToken = String(req.get('x-session-token') || '');
        const expectedToken = String(session.session_access_token || '');
        if (!expectedToken || !providedToken || providedToken !== expectedToken) {
            const error = new Error('Token de sesión requerido.');
            error.code = 'SESSION_ACCESS_REQUIRED';
            throw error;
        }
    }
    return session;
}

function statusFor(error) {
    if (error.code === 'SESSION_ACCESS_REQUIRED') return 401;
    if (error.code === 'SESSION_NOT_FOUND') return 404;
    if (error.code === 'STALE_SESSION') return 410;
    if (['PROFILE_SESSION_MISMATCH', 'PROFILE_NOT_RECOVERABLE', 'PROFILE_IN_USE', 'SESSION_LOCKED'].includes(error.code)) return 409;
    if (['PROFILE_ID_REQUIRED', 'SESSION_ID_REQUIRED', 'INVALID_CONSENT', 'MEMORY_CONSENT_REQUIRED', 'INVALID_MEMORY_TYPE', 'INVALID_MEMORY_SOURCE', 'INVALID_FORGET_SCOPE', 'INVALID_RETENTION_POLICY', 'INVALID_DISPLAY_NAME', 'INVALID_MEMORY_VALUE', 'MEMORY_VALUE_TOO_LARGE', 'SENSITIVE_MEMORY_REJECTED'].includes(error.code)) return 400;
    return 500;
}

export function createMemoryRouter({ orderSessionManager, memoryService, sessionLifecycle = null } = {}) {
    const router = Router();

    router.post('/profiles', async (req, res) => {
        const { session_id: sessionId, display_name: displayName, consent, retention_policy: retentionPolicy } = req.body || {};
        try {
            const session = sessionOrError(orderSessionManager, sessionId, req);
            if (!consent) {
                const error = new Error('El consentimiento explícito es obligatorio.');
                error.code = 'INVALID_CONSENT';
                throw error;
            }
            const profile = await memoryService.createProfile({
                sessionId,
                displayName,
                consent,
                retentionPolicy,
                source: 'user_declared',
                visitId: session.visit_id,
                tableId: session.mesa,
            });
            orderSessionManager.setMemoryProfile(sessionId, { profileId: profile.profile_id, consent: profile.consent_status });
            sessionLifecycle?.noteActivity?.(sessionId);
            return res.status(201).json({ ok: true, profile: { ...profile, profile_id: profile.profile_id || null }, memory_consent: profile.consent_status });
        } catch (error) {
            return res.status(statusFor(error)).json({ error: error.message, code: error.code || 'MEMORY_PROFILE_ERROR' });
        }
    });

    router.post('/sessions/:id/attach', async (req, res) => {
        try {
            const session = sessionOrError(orderSessionManager, req.params.id, req);
            const profile = await memoryService.attachProfileToSession({ sessionId: session.session_id, profileId: req.body?.profile_id, consent: req.body?.consent });
            orderSessionManager.setMemoryProfile(session.session_id, { profileId: profile.profile_id, consent: profile.consent_status });
            return res.json({ ok: true, profile: { profile_id: profile.profile_id, display_name: profile.display_name, consent_status: profile.consent_status, expires_at: profile.expires_at || null } });
        } catch (error) {
            return res.status(statusFor(error)).json({ error: error.message, code: error.code || 'MEMORY_ATTACH_ERROR' });
        }
    });

    router.get('/sessions/:id/summary', async (req, res) => {
        try {
            const session = sessionOrError(orderSessionManager, req.params.id, req);
            const profileId = session.profile_id || memoryService.getBoundProfileId(req.params.id);
            const summary = await memoryService.summary({ sessionId: session.session_id, profileId });
            return res.json({ ok: true, ...summary, consent: session.memory_consent || null });
        } catch (error) {
            return res.status(statusFor(error)).json({ error: error.message, code: error.code || 'MEMORY_SUMMARY_ERROR' });
        }
    });

    router.post('/sessions/:id/consent', async (req, res) => {
        const sessionId = req.params.id;
        try {
            const session = sessionOrError(orderSessionManager, sessionId, req);
            const consent = normalizeConsent(req.body?.consent);
            if (!consent) {
                const error = new Error('consent inválido.');
                error.code = 'INVALID_CONSENT';
                throw error;
            }
            const currentProfileId = session.profile_id || memoryService.getBoundProfileId(sessionId);
            if (currentProfileId) await memoryService.forget({ sessionId, profileId: currentProfileId, scope: 'all' });
            if (consent === 'disabled') {
                orderSessionManager.setMemoryProfile(sessionId, { profileId: null, consent: 'disabled' });
                return res.json({ ok: true, consent: 'disabled', summary: await memoryService.summary({ sessionId, profileId: null }) });
            }
            const profile = await memoryService.createProfile({
                sessionId,
                displayName: consent === 'temporary' ? req.body?.display_name : null,
                consent,
                retentionPolicy: normalizeRetentionPolicy(req.body?.retention_policy) || undefined,
                source: 'user_confirmed',
                visitId: session.visit_id,
                tableId: session.mesa,
            });
            orderSessionManager.setMemoryProfile(sessionId, { profileId: profile.profile_id, consent: profile.consent_status });
            return res.json({ ok: true, consent: profile.consent_status, profile: { profile_id: profile.profile_id, expires_at: profile.expires_at || null }, summary: await memoryService.summary({ sessionId, profileId: profile.profile_id }) });
        } catch (error) {
            return res.status(statusFor(error)).json({ error: error.message, code: error.code || 'MEMORY_CONSENT_ERROR' });
        }
    });

    router.post('/sessions/:id/remember', async (req, res) => {
        try {
            const session = sessionOrError(orderSessionManager, req.params.id, req);
            const profileId = session.profile_id || memoryService.getBoundProfileId(session.session_id);
            if (!profileId) return res.status(409).json({ error: 'Primero elige si deseas conservar memoria.', code: 'MEMORY_CONSENT_REQUIRED' });
            const result = await memoryService.remember({
                sessionId: session.session_id,
                profileId,
                memoryType: req.body?.memory_type,
                value: req.body?.value,
                source: 'user_declared',
                visitId: session.visit_id,
                tableId: session.mesa,
            });
            sessionLifecycle?.noteActivity?.(session.session_id);
            return res.status(201).json({ ok: true, memory: result, summary: await memoryService.summary({ sessionId: session.session_id, profileId }) });
        } catch (error) {
            return res.status(statusFor(error)).json({ error: error.message, code: error.code || 'MEMORY_RECORD_ERROR' });
        }
    });

    router.post('/sessions/:id/forget', async (req, res) => {
        try {
            const session = sessionOrError(orderSessionManager, req.params.id, req);
            const profileId = session.profile_id || memoryService.getBoundProfileId(session.session_id);
            if (!profileId) return res.json({ ok: true, forgotten: true, scope: req.body?.scope || 'all' });
            const result = await memoryService.forget({ sessionId: session.session_id, profileId, scope: req.body?.scope || 'all' });
            if (result.scope === 'all') orderSessionManager.setMemoryProfile(session.session_id, { profileId: null, consent: 'disabled' });
            return res.json({ ok: true, ...result, summary: await memoryService.summary({ sessionId: session.session_id, profileId: result.scope === 'all' ? null : profileId }) });
        } catch (error) {
            return res.status(statusFor(error)).json({ error: error.message, code: error.code || 'MEMORY_FORGET_ERROR' });
        }
    });

    router.get('/sessions/:id/last-order', async (req, res) => {
        try {
            const session = sessionOrError(orderSessionManager, req.params.id, req);
            const profileId = session.profile_id || memoryService.getBoundProfileId(session.session_id);
            if (!profileId) return res.json({ ok: true, last_order: null, requires_explicit_reorder: true });
            return res.json({ ok: true, last_order: await memoryService.getLastConfirmedOrder({ sessionId: session.session_id, profileId }), requires_explicit_reorder: true });
        } catch (error) {
            return res.status(statusFor(error)).json({ error: error.message, code: error.code || 'MEMORY_LAST_ORDER_ERROR' });
        }
    });

    return router;
}
