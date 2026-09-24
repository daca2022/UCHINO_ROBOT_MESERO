/**
 * Router /api/sessions — FASE 7
 *
 * Endpoints para inicio, asignación, cierre, recuperación y listado
 * de sesiones conversacionales del robot.
 *
 * POST /api/sessions/start
 *   { robot_id, mesa, source }
 *   → { session_id, session_status, mesa, robot_id, state, ... }
 *
 * GET /api/sessions/active
 *   → { data: [sesiones activas] }
 *
 * GET /api/sessions/:id
 *   → { session_id, ... } o 404
 *
 * POST /api/sessions/:id/close
 *   { reason, source }
 *   → { session_id, status, close_reason } (idempotente)
 *
 * POST /api/sessions/:id/recover
 *   → { ok, session } o { ok: false, error, code }
 *
 * POST /api/sessions/:id/mode
 *   { mode: 'voice' | 'screen' | 'human_waiter' }
 *   → { session_id, interaction_mode, session_status }
 *
 * POST /api/sessions/:id/activity
 *   → { ok: true } — nota actividad (resetea timer de inactividad)
 *
 * POST /api/sessions/:id/assign-robot
 *   { robot_id }
 *   → { session_id, robot_id, assignment }
 *
 * POST /api/sessions/:id/release-robot
 *   { reason }
 *   → { session_id, robot_id, status }
 *
 * GET /api/sessions
 *   → { data: [sesiones activas] }
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { adminAuth } from '../middleware/adminAuth.mjs';
import { JWT_SECRET } from '../config/adminSecurity.mjs';

function safe(value) {
    return value === null || value === undefined ? null : value;
}

function sessionPublic(svc, session, { includeAccessToken = false } = {}) {
    if (!session) return null;
    const snapshot = svc.snapshot(session.session_id);
    if (includeAccessToken && session.session_access_token) {
        snapshot.session_access_token = session.session_access_token;
    }
    return snapshot;
}

function requireSessionToken(session, req, res) {
    const providedToken = String(req.get('x-session-token') || '');
    const expectedToken = String(session?.session_access_token || '');
    if (!expectedToken || !providedToken || providedToken !== expectedToken) {
        res.status(401).json({ error: 'Token de sesión requerido.', code: 'SESSION_ACCESS_REQUIRED' });
        return false;
    }
    return true;
}

function isAdminRequest(req) {
    const authorization = String(req.get('authorization') || '');
    const [scheme, token] = authorization.split(/\s+/u);
    if (scheme?.toLowerCase() !== 'bearer' || !token) return false;
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        return payload?.role === 'admin' || payload?.is_admin === true;
    } catch {
        return false;
    }
}

function requireSessionOrAdmin(session, req, res) {
    if (isAdminRequest(req)) return true;
    return requireSessionToken(session, req, res);
}

function requireAdmin(req, res) {
    if (isAdminRequest(req)) return true;
    res.status(401).json({ error: 'Autorización Admin requerida.', code: 'ADMIN_AUTH_REQUIRED' });
    return false;
}

function normalizeGuestCount(value) {
    if (value === null || value === undefined || value === '') return null;
    const count = Number(value);
    if (!Number.isInteger(count) || count < 1 || count > 999) {
        const error = new Error('guest_count debe ser un entero positivo.');
        error.code = 'INVALID_GUEST_COUNT';
        throw error;
    }
    return count;
}

export function createSessionsRouter(sessionLifecycle, orderSessionManager, tableService = null, waiterAssistanceService = null) {
    const router = Router();

    // ── POST /api/sessions/start ──────────────────────────────
    router.post('/start', async (req, res) => {
        const { robot_id, mesa, source, additional_order, continue_visit, visit_id, guest_count } = req.body || {};
        const robotId = robot_id || 'uchino-01';
        try {
            if (String(source || '').trim().toLowerCase() === 'admin' && !requireAdmin(req, res)) return;
            const normalizedMesa = safe(mesa);
            const guestCount = normalizeGuestCount(guest_count);
            if (tableService && normalizedMesa) {
                const currentTable = continue_visit && !visit_id
                    ? await tableService.getTable(normalizedMesa)
                    : null;
                const resolvedVisitId = visit_id || currentTable?.current_visit_id || null;
                const result = continue_visit && resolvedVisitId
                    ? await tableService.continueVisit({
                        tableId: normalizedMesa,
                        visitId: resolvedVisitId,
                        robotId,
                        source: source || 'manual',
                        guestCount,
                    })
                    : await tableService.startVisit({
                        tableId: normalizedMesa,
                        robotId,
                        source: source || 'manual',
                        additionalOrder: Boolean(additional_order),
                        guestCount,
                    });
                return res.status(result.continued ? 200 : 201).json({
                    ...(result.session ? sessionPublic(sessionLifecycle, result.session, { includeAccessToken: true }) : {}),
                    table: result.table,
                    visit: result.visit,
                    continued: Boolean(result.continued),
                });
            }
            const session = sessionLifecycle.start({ robotId, mesa: normalizedMesa, source: source || 'manual', guestCount });
            return res.status(201).json(sessionPublic(sessionLifecycle, session, { includeAccessToken: true }));
        } catch (err) {
            const status = ['ROBOT_BUSY', 'TABLE_OCCUPIED', 'NO_ACTIVE_VISIT', 'TABLE_DISABLED', 'ADDITIONAL_ORDERS_DISABLED', 'VISIT_NOT_FOUND', 'TABLE_CONFLICT', 'STALE_VISIT'].includes(err.code) ? 409 : 400;
            return res.status(status).json({ error: err.message, code: err.code });
        }
    });

    // ── GET /api/sessions/active ─────────────────────────────
    router.get('/active', adminAuth, (req, res) => {
        const sessions = sessionLifecycle.listActive().map(s => sessionPublic(sessionLifecycle, s));
        res.json({ data: sessions, count: sessions.length });
    });

    // ── GET /api/sessions (alias + historial reciente opcional) ──
    router.get('/', adminAuth, (req, res) => {
        const includeClosed = String(req.query.include_closed || '').toLowerCase() === 'true';
        const sessions = includeClosed
            ? sessionLifecycle.listAll({ limit: req.query.limit }).map(session => sessionPublic(sessionLifecycle, session))
            : sessionLifecycle.listActive().map(s => sessionPublic(sessionLifecycle, s));
        res.json({ data: sessions, count: sessions.length });
    });

    // ── GET /api/sessions/:id ────────────────────────────────
    router.get('/:id', (req, res) => {
        const session = sessionLifecycle.get(req.params.id);
        if (session && !requireSessionOrAdmin(session, req, res)) return;
        const snap = sessionLifecycle.snapshot(req.params.id);
        if (!snap) return res.status(404).json({ error: 'Sesión no encontrada', code: 'SESSION_NOT_FOUND' });
        res.json(snap);
    });

    // ── POST /api/sessions/:id/close ────────────────────────
    router.post('/:id/close', (req, res) => {
        const { reason, source } = req.body || {};
        const existing = sessionLifecycle.get(req.params.id);
        if (existing && !requireSessionOrAdmin(existing, req, res)) return;
        const result = sessionLifecycle.close({
            sessionId: req.params.id,
            reason: reason || 'admin_closed',
            source: source || 'admin',
        });
        if (!result || !result.session) {
            return res.status(404).json({ error: 'Sesión no encontrada', code: 'SESSION_NOT_FOUND' });
        }
        res.json({
            session_id: result.session.session_id,
            status: result.session.session_status,
            close_reason: result.session.close_reason,
            robot_id: result.robotId,
            already_closed: result.alreadyClosed,
        });
    });

    // ── POST /api/sessions/:id/recover ──────────────────────
    router.post('/:id/recover', (req, res) => {
        const existing = sessionLifecycle.get(req.params.id);
        if (existing && !requireSessionOrAdmin(existing, req, res)) return;
        const result = sessionLifecycle.recover({ sessionId: req.params.id });
        if (!result.ok) {
            const status = result.code === 'STALE_SESSION' ? 410
                : result.code === 'SESSION_NOT_FOUND' ? 404
                : 400;
            return res.status(status).json({
                ok: false,
                error: result.error,
                code: result.code,
                session_status: result.session_status,
            });
        }
        res.json({ ok: true, session: sessionPublic(sessionLifecycle, result.session, { includeAccessToken: true }) });
    });

    // ── POST /api/sessions/:id/robot-bootstrap ──────────────
    // Canjea una concesión efímera entregada al /robot por WS. Nunca acepta
    // el token privado directamente por WebSocket y la concesión es de un uso.
    router.post('/:id/robot-bootstrap', (req, res) => {
        const { robot_id, bootstrap_token, robot_connection_token } = req.body || {};
        const result = sessionLifecycle.redeemRobotBootstrap({
            sessionId: req.params.id,
            robotId: String(robot_id || ''),
            bootstrapToken: bootstrap_token,
            robotConnectionToken: robot_connection_token,
        });
        if (!result.ok) {
            const status = result.code === 'SESSION_NOT_FOUND' ? 404
                : ['STALE_SESSION', 'EXPIRED_ROBOT_BOOTSTRAP'].includes(result.code) ? 410
                    : 401;
            return res.status(status).json({
                ok: false,
                error: result.error,
                code: result.code,
                session_status: result.session_status,
            });
        }
        res.json({
            ok: true,
            session: sessionPublic(sessionLifecycle, result.session, { includeAccessToken: true }),
        });
    });

    // ── POST /api/sessions/:id/mode ────────────────────────
    router.post('/:id/mode', (req, res) => {
        const existing = sessionLifecycle.get(req.params.id);
        if (existing && !requireSessionOrAdmin(existing, req, res)) return;
        const { mode } = req.body || {};
        if (!['voice', 'screen', 'human_waiter'].includes(mode)) {
            return res.status(400).json({ error: 'mode inválido', code: 'INVALID_MODE' });
        }
        try {
            const session = sessionLifecycle.setInteractionMode(req.params.id, mode);
            res.json({
                session_id: session.session_id,
                interaction_mode: mode,
                session_status: session.session_status,
                state: session.state,
            });
        } catch (err) {
            const status = err.code === 'STALE_SESSION' ? 410
                : err.message?.startsWith('Sesión no encontrada') ? 404
                    : err.code === 'ORDER_LOCKED' ? 409 : 400;
            res.status(status).json({ error: err.message, code: err.code || 'SESSION_ERROR' });
        }
    });

    // ── POST /api/sessions/:id/party-size ──────────────────
    router.post('/:id/party-size', async (req, res) => {
        try {
            const guestCount = normalizeGuestCount(req.body?.guest_count);
            if (guestCount === null) throw Object.assign(new Error('guest_count es obligatorio.'), { code: 'INVALID_GUEST_COUNT' });
            const session = sessionLifecycle.get(req.params.id);
            if (!session) return res.status(404).json({ error: 'Sesión no encontrada', code: 'SESSION_NOT_FOUND' });
            if (!requireSessionOrAdmin(session, req, res)) return;
            sessionLifecycle.assertGuestCountChange?.(req.params.id, guestCount);
            let visit = null;
            if (tableService && session.mesa && session.visit_id) {
                visit = await tableService.setGuestCount(session.mesa, session.visit_id, guestCount);
            }
            const updated = sessionLifecycle.setGuestCount(req.params.id, guestCount);
            res.json({
                ok: true,
                session: sessionPublic(sessionLifecycle, updated),
                visit,
            });
        } catch (err) {
            const status = err.code === 'STALE_SESSION' ? 410
                : err.code === 'ORDER_LOCKED' ? 409
                : err.code === 'VISIT_NOT_FOUND' ? 409 : 400;
            res.status(status).json({ error: err.message, code: err.code || 'PARTY_SIZE_ERROR' });
        }
    });

    router.post('/:id/move-table', async (req, res) => {
        try {
            const session = sessionLifecycle.get(req.params.id);
            if (!session) return res.status(404).json({ error: 'Sesión no encontrada', code: 'SESSION_NOT_FOUND' });
            if (!requireSessionOrAdmin(session, req, res)) return;
            if (!tableService?.moveDraftOrder) {
                return res.status(501).json({ error: 'Movimiento de mesa no disponible', code: 'MOVE_TABLE_UNAVAILABLE' });
            }
            const result = await tableService.moveDraftOrder({
                sessionId: req.params.id,
                orderId: req.body?.order_id || null,
                targetTableId: req.body?.mesa || req.body?.table_id,
                source: req.body?.source || 'robot_screen',
            });
            res.json({ ok: true, ...result, session: sessionPublic(sessionLifecycle, sessionLifecycle.get(req.params.id)) });
        } catch (err) {
            const status = ['TABLE_LOCKED', 'TABLE_OCCUPIED', 'STALE_VISIT', 'SESSION_NOT_FOUND', 'ORDER_NOT_FOUND', 'ORDER_OWNERSHIP_MISMATCH', 'ROBOT_STATE_CONFLICT'].includes(err.code) ? 409
                : err.code === 'INVALID_TABLE' ? 400 : 500;
            res.status(status).json({ error: err.message, code: err.code || 'MOVE_TABLE_ERROR' });
        }
    });

    // ── POST /api/sessions/:id/activity ────────────────────
    router.post('/:id/waiter-assistance', async (req, res) => {
        const session = orderSessionManager.get(req.params.id);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada', code: 'SESSION_NOT_FOUND' });
        if (!requireSessionOrAdmin(session, req, res)) return;
        if (!session.mesa) return res.status(400).json({ error: 'La sesión no tiene mesa asociada', code: 'MISSING_TABLE' });
        if (!waiterAssistanceService?.request) return res.status(503).json({ error: 'Servicio de asistencia no disponible', code: 'WAITER_SERVICE_UNAVAILABLE' });
        if (session.session_status === 'expired' || (session.session_status === 'closed' && !['confirmed', 'completed'].includes(session.state))) {
            return res.status(410).json({ error: `Sesión ${session.session_status}`, code: 'STALE_SESSION' });
        }
        try {
            const result = await waiterAssistanceService.request({
                session_id: session.session_id,
                mesa: session.mesa,
                table_id: session.mesa,
                visit_id: session.visit_id || null,
                robot_id: session.robot_id || session.assignment?.robot_id || null,
                origin: req.body?.source || 'robot_screen',
            });
            res.json({ ok: true, ...result, session: sessionPublic(sessionLifecycle, session) });
        } catch (error) {
            res.status(400).json({ error: error.message, code: error.code || 'WAITER_REQUEST_ERROR' });
        }
    });

    router.post('/:id/activity', (req, res) => {
        const session = orderSessionManager.get(req.params.id);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada', code: 'SESSION_NOT_FOUND' });
        if (!requireSessionOrAdmin(session, req, res)) return;
        if (['closed', 'expired', 'completing'].includes(session.session_status)) {
            return res.status(410).json({ error: `Sesión ${session.session_status}`, code: 'STALE_SESSION', session_status: session.session_status });
        }
        sessionLifecycle.noteActivity(req.params.id);
        res.json({ ok: true });
    });

    // ── POST /api/sessions/:id/assign-robot ──────────────
    router.post('/:id/assign-robot', (req, res) => {
        if (!requireAdmin(req, res)) return;
        const { robot_id } = req.body || {};
        if (!robot_id) return res.status(400).json({ error: 'robot_id es obligatorio', code: 'ROBOT_REQUIRED' });
        try {
            const session = sessionLifecycle.assignRobot(req.params.id, robot_id);
            res.json({
                session_id: session.session_id,
                robot_id,
                assignment: session.assignment,
            });
        } catch (err) {
            const status = err.code === 'STALE_SESSION' ? 410
                : err.message?.startsWith('Sesión no encontrada') ? 404 : 409;
            res.status(status).json({ error: err.message, code: err.code || 'ROBOT_BUSY' });
        }
    });

    // ── POST /api/sessions/:id/release-robot ──────────────
    router.post('/:id/release-robot', (req, res) => {
        if (!requireAdmin(req, res)) return;
        const { reason } = req.body || {};
        try {
            const session = sessionLifecycle.releaseRobot(req.params.id, { reason });
            if (!session) return res.status(404).json({ error: 'Sesión no encontrada', code: 'SESSION_NOT_FOUND' });
            res.json({
                session_id: session.session_id,
                robot_id: session.assignment?.robot_id || null,
                status: session.assignment?.status || 'released',
            });
        } catch (err) {
            const status = err.code === 'STALE_SESSION' ? 410
                : err.message?.startsWith('Sesión no encontrada') ? 404 : 409;
            res.status(status).json({ error: err.message, code: err.code || 'SESSION_ERROR' });
        }
    });

    return router;
}
