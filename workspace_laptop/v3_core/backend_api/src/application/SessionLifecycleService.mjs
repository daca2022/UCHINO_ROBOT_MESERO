/**
 * SessionLifecycleService — FASE 7
 *
 * Orquesta el ciclo de vida de la sesión conversacional: inicio,
 * asignación de mesa, modo de atención, cierre, expiración por
 * inactividad y recuperación tras recarga.
 *
 * Tres conceptos separados, como exige el prompt maestro:
 *
 * 1. PEDIDO — vive en PostgreSQL, no se borra al cerrar la sesión.
 * 2. SESIÓN CONVERSACIONAL — vive en OrderSessionManager (en memoria),
 *    identifica una interacción entre Uchino y una mesa.
 * 3. ASIGNACIÓN DE ATENCIÓN — objeto `session.assignment` que vincula
 *    robot_id con mesa. Se libera al cerrar la sesión.
 *
 * La sesión es idempotente en su cierre: cerrar dos veces no falla ni
 * duplica eventos. La asignación de robot es exclusiva: no pueden
 * existir dos sesiones activas para el mismo robot.
 */

import { randomUUID } from 'node:crypto';

const SESSION_STATUS = Object.freeze({
    INITIALIZING: 'initializing',
    ACTIVE: 'active',
    COMPLETING: 'completing',
    CLOSED: 'closed',
    EXPIRED: 'expired',
});

const ASSIGNMENT_STATUS = Object.freeze({
    UNASSIGNED: 'unassigned',
    ASSIGNED: 'assigned',
    ATTENDING: 'attending',
    RELEASED: 'released',
});

const CLOSE_REASONS = Object.freeze({
    ORDER_CONFIRMED: 'order_confirmed',
    USER_CANCELLED: 'user_cancelled',
    NO_ORDER: 'no_order',
    HUMAN_WAITER_REQUESTED: 'human_waiter_requested',
    INACTIVITY_TIMEOUT: 'inactivity_timeout',
    ADMIN_CLOSED: 'admin_closed',
    SYSTEM_ERROR: 'system_error',
    NAVIGATION_REASSIGNED: 'navigation_reassigned',
    ROBOT_RELEASED: 'robot_released',
});

const ROBOT_BOOTSTRAP_TTL_MS = 120_000;
const ROBOT_CONNECTION_TTL_MS = 600_000;

/**
 * Genera un identificador de sesión con prefijo operativo y sufijo opaco.
 */
function generateSessionId({ robotId = 'uchino-01', mesa = null } = {}) {
    return `${robotId}${mesa ? `-${mesa}` : ''}-${randomUUID()}`;
}

export class SessionLifecycleService {
    constructor({
        orderSessionManager,
        memoryService = null,
        sendToUI = null,
        safetyService = null,
        pool = null,
        stopSessionAudio = null,
        inactivityWarningMs = 60_000,
        inactivityCloseMs = 30_000,
        logger = console,
    } = {}) {
        this._orderSessionManager = orderSessionManager;
        this._memoryService = memoryService;
        this._sendToUI = typeof sendToUI === 'function' ? sendToUI : null;
        this._safetyService = safetyService || null;
        this._pool = pool || null;
        this._stopSessionAudio = typeof stopSessionAudio === 'function' ? stopSessionAudio : null;
        this._inactivityWarningMs = inactivityWarningMs;
        this._inactivityCloseMs = inactivityCloseMs;
        this._logger = logger;
        this._sessionClosedHandler = null;
        // Timers de inactividad por session_id.
        this._inactivityTimers = new Map();
        this._inactivityWarnings = new Map();
        // Concesiones efímeras para que la pantalla /robot pueda reclamar una
        // atención iniciada por Admin sin exponer el token de sesión por WS.
        this._robotBootstrapGrants = new Map();
        this._robotConnectionTokens = new Map();
    }

    setSessionClosedHandler(handler) {
        this._sessionClosedHandler = typeof handler === 'function' ? handler : null;
    }

    /**
     * Registra un callback para transiciones físicas del robot
     * (asignación, liberación). Llamado por start/close/releaseRobot.
     */
    setRobotTransitionHandler(handler) {
        this._robotTransitionHandler = typeof handler === 'function' ? handler : null;
    }

    notifyRobotVisitAttached(sessionId, visitId) {
        const session = this._orderSessionManager.get(sessionId);
        if (!session || !visitId) return session || null;
        session.visit_id = visitId;
        if (this._robotTransitionHandler && session.assignment?.robot_id && session.mesa) {
            try {
                this._robotTransitionHandler({
                    action: 'visit_attached',
                    robotId: session.assignment.robot_id,
                    mesa: session.mesa,
                    sessionId: session.session_id,
                    visitId,
                });
            } catch (error) {
                this._logger.warn(`[FASE7] robotTransitionHandler visit attach error: ${error.message}`);
            }
        }
        return session;
    }

    // ── API pública ───────────────────────────────────────────

    /**
     * Inicia una nueva sesión. Si robotId ya tiene sesión activa, cierra
     * la anterior (replacement) y crea una nueva. Devuelve la sesión creada.
     *
     * @param {object} params
     * @param {string} params.robotId
     * @param {string|null} params.mesa
     * @param {string} [params.source='ros2_simulation']
     * @param {boolean} [params.replaceExisting=true]
     */
    start({ robotId, mesa = null, source = 'ros2_simulation', replaceExisting = true, visitId = null, guestCount = null } = {}) {
        if (!robotId) throw new Error('robotId es obligatorio');
        // Si el robot ya tiene sesión activa, cerrarla (release + close).
        const existing = this._orderSessionManager.getActiveSessionForRobot(robotId);
        let audioStopped = false;
        if (existing) {
            if (!replaceExisting) {
                const err = new Error(`El robot ${robotId} ya tiene sesión activa: ${existing.session_id}`);
                err.code = 'ROBOT_BUSY';
                throw err;
            }
            this._logger.warn(`[FASE7] Reemplazando sesión activa del robot ${robotId}: ${existing.session_id}`);
            this.close({ sessionId: existing.session_id, reason: CLOSE_REASONS.NAVIGATION_REASSIGNED, source });
            audioStopped = true;
        }
        if (!audioStopped) this._cancelSessionAudio('new_session');
        const sessionId = generateSessionId({ robotId, mesa });
        const session = this._orderSessionManager.getOrCreate(sessionId, {
            mesa,
            visitId,
            robotId,
            guestCount,
        });
        session.session_status = SESSION_STATUS.INITIALIZING;
        session.robot_id = robotId;
        session.assignment = {
            robot_id: robotId,
            mesa: mesa || session.mesa || null,
            status: mesa ? ASSIGNMENT_STATUS.ATTENDING : ASSIGNMENT_STATUS.ASSIGNED,
            assigned_at: new Date().toISOString(),
            source,
        };
        if (mesa) session.mesa = mesa;
        if (visitId) session.visit_id = visitId;
        session.session_access_token = randomUUID();
        this._createRobotBootstrapGrant(session);
        session.last_activity_at = new Date().toISOString();
        // Inicia modo de atención: forzar CHOOSING_INTERACTION_MODE.
        this._orderSessionManager.setState(sessionId, 'choosing_interaction_mode');
        this._emit('session_started', session, { source });
        this._emit('session_assigned_to_table', session, { mesa: session.assignment.mesa, source });
        this._recordAudit(session, 'session_started', { robot_id: robotId, mesa, source });
        this._startInactivityTimer(sessionId);
        // Notificar transición física del robot
        if (this._robotTransitionHandler && mesa) {
            try {
                this._robotTransitionHandler({
                    action: 'assigned',
                    robotId,
                    mesa: session.assignment.mesa,
                    sessionId,
                    visitId: session.visit_id || visitId || null,
                });
            } catch (e) {
                this._logger.warn(`[FASE7] robotTransitionHandler error: ${e.message}`);
            }
        }
        this._emit('session_mode_required', session, {});
        return session;
    }

    /**
     * Inicia una sesión por selección manual desde /robot o Admin,
     * sin robot_id ni ROS 2. El robot_id por defecto es 'uchino-01'.
     */
    startManual({ mesa = null, source = 'manual' } = {}) {
        return this.start({ robotId: 'uchino-01', mesa, source });
    }

    /**
     * Inicia una sesión a partir de un evento de navegación (robot
     * llegó a una mesa). Equivalente a start() con source='ros2_simulation'.
     */
    onRobotArrived({ robotId, mesa, source = 'ros2_simulation' } = {}) {
        return this.start({ robotId, mesa, source });
    }

    get(sessionId) {
        return this._orderSessionManager.get(sessionId);
    }

    getActiveSessionForRobot(robotId) {
        return this._orderSessionManager.getActiveSessionForRobot(robotId);
    }

    registerRobotConnection({ robotId, connectionId } = {}) {
        if (!robotId || !connectionId) return null;
        const token = randomUUID();
        this._robotConnectionTokens.set(token, {
            robotId: String(robotId),
            connectionId: String(connectionId),
            expiresAt: Date.now() + ROBOT_CONNECTION_TTL_MS,
        });
        return {
            robot_id: String(robotId),
            robot_connection_token: token,
            expires_at: new Date(Date.now() + ROBOT_CONNECTION_TTL_MS).toISOString(),
        };
    }

    validateRobotConnection({ robotId, connectionId = null, connectionToken } = {}) {
        const token = String(connectionToken || '');
        const binding = this._robotConnectionTokens.get(token);
        if (!binding || binding.expiresAt <= Date.now()) {
            if (binding) this._robotConnectionTokens.delete(token);
            return false;
        }
        return binding.robotId === String(robotId || '')
            && (!connectionId || binding.connectionId === String(connectionId));
    }

    revokeRobotConnection({ connectionToken } = {}) {
        if (connectionToken) this._robotConnectionTokens.delete(String(connectionToken));
    }

    /**
     * Devuelve una concesión efímera pendiente para la pantalla del robot.
     * La concesión no contiene el token privado de la sesión y solo se puede
     * canjear una vez mediante redeemRobotBootstrap().
     */
    getRobotBootstrapGrant({ robotId, sessionId = null } = {}) {
        const now = Date.now();
        for (const [token, grant] of this._robotBootstrapGrants) {
            if (grant.expiresAt <= now) {
                this._robotBootstrapGrants.delete(token);
                continue;
            }
            if (grant.robotId !== robotId || (sessionId && grant.sessionId !== sessionId)) continue;
            const session = this._orderSessionManager.get(grant.sessionId);
            if (!session || [SESSION_STATUS.CLOSED, SESSION_STATUS.EXPIRED, SESSION_STATUS.COMPLETING].includes(session.session_status)) {
                this._robotBootstrapGrants.delete(token);
                continue;
            }
            return {
                session_id: grant.sessionId,
                robot_id: grant.robotId,
                mesa: session.mesa || null,
                robot_bootstrap_token: token,
                expires_at: new Date(grant.expiresAt).toISOString(),
            };
        }
        return null;
    }

    redeemRobotBootstrap({ sessionId, robotId, bootstrapToken, robotConnectionToken } = {}) {
        if (!this.validateRobotConnection({ robotId, connectionToken: robotConnectionToken })) {
            return { ok: false, error: 'Conexión de robot requerida.', code: 'ROBOT_CONNECTION_REQUIRED' };
        }
        const token = String(bootstrapToken || '');
        const grant = this._robotBootstrapGrants.get(token);
        if (!grant || grant.sessionId !== sessionId || grant.robotId !== robotId) {
            return { ok: false, error: 'Concesión de robot inválida.', code: 'INVALID_ROBOT_BOOTSTRAP' };
        }
        if (grant.expiresAt <= Date.now()) {
            this._robotBootstrapGrants.delete(token);
            return { ok: false, error: 'Concesión de robot expirada.', code: 'EXPIRED_ROBOT_BOOTSTRAP' };
        }
        const session = this._orderSessionManager.get(sessionId);
        if (!session) {
            this._robotBootstrapGrants.delete(token);
            return { ok: false, error: 'Sesión no encontrada.', code: 'SESSION_NOT_FOUND' };
        }
        if (session.session_status === SESSION_STATUS.CLOSED
            || session.session_status === SESSION_STATUS.EXPIRED
            || session.session_status === SESSION_STATUS.COMPLETING) {
            this._robotBootstrapGrants.delete(token);
            return { ok: false, error: `Sesión ${session.session_status}.`, code: 'STALE_SESSION', session_status: session.session_status };
        }
        const assignedRobot = session.assignment?.robot_id || session.robot_id || null;
        if (assignedRobot !== robotId) {
            return { ok: false, error: 'La sesión no pertenece a este robot.', code: 'ROBOT_MISMATCH' };
        }
        // Consumo atómico en memoria: un retry posterior ya no obtiene el
        // token privado de esta sesión por esta vía.
        this._robotBootstrapGrants.delete(token);
        this.noteActivity(sessionId);
        return { ok: true, session };
    }

    /**
     * Marca el modo de atención seleccionado por la sesión.
     * El session_status pasa de 'initializing' a 'active'.
     */
    setInteractionMode(sessionId, mode) {
        const session = this._orderSessionManager.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SESSION_STATUS.CLOSED, SESSION_STATUS.EXPIRED, SESSION_STATUS.COMPLETING].includes(session.session_status)) {
            const error = new Error(`Sesión ${session.session_status}`);
            error.code = 'STALE_SESSION';
            throw error;
        }
        if (session.session_status === SESSION_STATUS.ACTIVE && session.interaction_mode === mode) return session;
        this._orderSessionManager.setInteractionMode(sessionId, mode);
        session.session_status = SESSION_STATUS.ACTIVE;
        session.last_activity_at = new Date().toISOString();
        this._emit('session_mode_selected', session, { mode });
        this._recordAudit(session, 'session_mode_selected', { mode });
        this._startInactivityTimer(sessionId);
        return session;
    }

    setGuestCount(sessionId, guestCount) {
        this.assertGuestCountChange(sessionId, guestCount);
        const updated = this._orderSessionManager.setGuestCount(sessionId, guestCount);
        this._emit('party_size_updated', updated, { guest_count: updated.guest_count });
        this._recordAudit(updated, 'party_size_updated', { guest_count: updated.guest_count });
        this._startInactivityTimer(sessionId);
        return updated;
    }

    assertGuestCountChange(sessionId, guestCount) {
        const session = this._orderSessionManager.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SESSION_STATUS.CLOSED, SESSION_STATUS.EXPIRED, SESSION_STATUS.COMPLETING].includes(session.session_status)) {
            const error = new Error(`Sesión ${session.session_status}`);
            error.code = 'STALE_SESSION';
            throw error;
        }
        if (['confirmed', 'completed'].includes(session.state)) {
            const error = new Error('El tamaño del grupo no puede cambiar después de confirmar el pedido.');
            error.code = 'ORDER_LOCKED';
            throw error;
        }
        const count = Number(guestCount);
        if (!Number.isInteger(count) || count < 1) {
            const error = new Error('guest_count debe ser un entero positivo.');
            error.code = 'INVALID_GUEST_COUNT';
            throw error;
        }
        return session;
    }

    prepareTableMove(sessionId, { mesa, visitId, source = 'table_move' } = {}) {
        const session = this._orderSessionManager.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SESSION_STATUS.CLOSED, SESSION_STATUS.EXPIRED, SESSION_STATUS.COMPLETING].includes(session.session_status)
            || ['confirmed', 'completed'].includes(session.state)) {
            const error = new Error('La atención ya está cerrada o el pedido fue confirmado.');
            error.code = 'TABLE_LOCKED';
            throw error;
        }
        const previous = {
            mesa: session.mesa,
            visit_id: session.visit_id || null,
            assignment: session.assignment ? { ...session.assignment } : null,
            last_activity_at: session.last_activity_at,
        };
        let applied = false;
        return {
            apply: () => {
                if (applied) return session;
                const updated = this._orderSessionManager.updateMesa(sessionId, mesa);
                updated.visit_id = visitId || null;
                if (updated.assignment) updated.assignment = { ...updated.assignment, mesa: updated.mesa };
                updated.last_activity_at = new Date().toISOString();
                applied = true;
                return updated;
            },
            rollback: () => {
                if (!applied) return session;
                session.mesa = previous.mesa;
                session.visit_id = previous.visit_id;
                session.assignment = previous.assignment ? { ...previous.assignment } : null;
                session.last_activity_at = previous.last_activity_at;
                applied = false;
                return session;
            },
            finalize: () => {
                if (!applied) return session;
                this._emit('session_table_changed', session, { mesa: session.mesa, visit_id: session.visit_id, source });
                this._recordAudit(session, 'session_table_changed', { mesa: session.mesa, visit_id: session.visit_id, source });
                if (this._robotTransitionHandler && session.assignment?.robot_id) {
                    try {
                        this._robotTransitionHandler({
                            action: 'moved',
                            robotId: session.assignment.robot_id,
                            mesa: session.mesa,
                            sessionId: session.session_id,
                            visitId: session.visit_id,
                        });
                    } catch (error) {
                        this._logger.warn(`[FASE7] robotTransitionHandler move error: ${error.message}`);
                    }
                }
                return session;
            },
            session,
        };
    }

    moveToTable(sessionId, params = {}) {
        const move = this.prepareTableMove(sessionId, params);
        move.apply();
        return move.finalize();
    }

    /**
     * Registra actividad (ASR turn, pedido, etc.) para resetear el timer
     * de inactividad.
     */
    noteActivity(sessionId) {
        const session = this._orderSessionManager.get(sessionId);
        if (!session) return;
        if ([SESSION_STATUS.CLOSED, SESSION_STATUS.EXPIRED, SESSION_STATUS.COMPLETING].includes(session.session_status)) return null;
        session.last_activity_at = new Date().toISOString();
        this._startInactivityTimer(sessionId);
        return session;
    }

    /**
     * Cierra la sesión completamente. Idempotente: cerrar dos veces
     * devuelve el mismo resultado sin fallar. Libera el robot.
     *
     * @param {object} params
     * @param {string} params.sessionId
     * @param {string} [params.reason='admin_closed']
     * @param {string} [params.source]
     * @param {boolean} [params.stopAudio=true]
     */
    close({ sessionId, reason = CLOSE_REASONS.ADMIN_CLOSED, source = null, stopAudio = true } = {}) {
        const session = this._orderSessionManager.get(sessionId);
        if (!session) return { session: null, robotId: null, alreadyClosed: true };
        if (session.session_status === SESSION_STATUS.CLOSED
            || session.session_status === SESSION_STATUS.EXPIRED) {
            return { session, robotId: session.assignment?.robot_id || null, alreadyClosed: true };
        }
        session.session_status = SESSION_STATUS.COMPLETING;
        this._revokeRobotBootstrapGrants(sessionId);
        this._emit('session_completing', session, { close_reason: reason });
        const robotId = session.assignment?.robot_id || null;
        const closeResult = this._orderSessionManager.closeSessionCompletely(sessionId, { reason });
        const result = {
            session: closeResult.session,
            robotId,
            alreadyClosed: false,
            close_reason: reason,
        };
        if (stopAudio) this._cancelSessionAudio(reason);
        this._clearInactivityTimer(sessionId);
        this._emit('session_closed', closeResult.session, { close_reason: reason, source, robot_id: robotId });
        this._recordAudit(closeResult.session, 'session_closed', { reason, source, robot_id: robotId });
        this._notifySessionClosed(closeResult.session, { reason, source });
        this._emit('robot_available_for_attention', closeResult.session, { robot_id: robotId });
        // Notificar liberación física del robot
        if (this._robotTransitionHandler && robotId) {
            try {
                this._robotTransitionHandler({
                    action: 'released',
                    robotId,
                    mesa: closeResult.session?.mesa || null,
                    sessionId,
                });
            } catch (e) {
                this._logger.warn(`[FASE7] robotTransitionHandler error: ${e.message}`);
            }
        }
        return result;
    }

    /**
     * Cierre llamado automáticamente cuando se confirma un pedido.
     */
    closeAfterOrderConfirmed(sessionId) {
        return this.close({
            sessionId,
            reason: CLOSE_REASONS.ORDER_CONFIRMED,
            source: 'backend_confirmation',
            stopAudio: false,
        });
    }

    /**
     * Marca la sesión como expirada por inactividad.
     */
    expireForInactivity(sessionId) {
        const session = this._orderSessionManager.get(sessionId);
        if (!session) return null;
        if (session.session_status === SESSION_STATUS.CLOSED
            || session.session_status === SESSION_STATUS.EXPIRED) return session;
        const robotId = session.assignment?.robot_id || null;
        this._clearInactivityTimer(sessionId);
        this._cancelSessionAudio(CLOSE_REASONS.INACTIVITY_TIMEOUT);
        this._orderSessionManager.expireSession(sessionId, { reason: CLOSE_REASONS.INACTIVITY_TIMEOUT });
        this._emit('session_expired', session, { reason: CLOSE_REASONS.INACTIVITY_TIMEOUT, robot_id: robotId });
        this._recordAudit(session, 'session_expired', { reason: CLOSE_REASONS.INACTIVITY_TIMEOUT });
        this._notifySessionClosed(session, { reason: CLOSE_REASONS.INACTIVITY_TIMEOUT, source: 'inactivity_timeout' });
        this._emit('robot_available_for_attention', session, { robot_id: robotId });
        if (this._robotTransitionHandler && robotId) {
            try {
                this._robotTransitionHandler({
                    action: 'released',
                    robotId,
                    mesa: session.mesa || null,
                    sessionId,
                });
            } catch (error) {
                this._logger.warn(`[FASE7] robotTransitionHandler timeout error: ${error.message}`);
            }
        }
        return session;
    }

    /**
     * Cierre cuando el usuario pide un mesero humano. Conserva la
     * solicitud humana; pausa o cierra la conversación automática.
     */
    closeForHumanWaiter(sessionId) {
        return this.close({
            sessionId,
            reason: CLOSE_REASONS.HUMAN_WAITER_REQUESTED,
            source: 'human_waiter_requested',
        });
    }

    /**
     * Cierre sin pedido: el usuario canceló o no pidió nada.
     */
    closeWithoutOrder(sessionId) {
        return this.close({
            sessionId,
            reason: CLOSE_REASONS.NO_ORDER,
            source: 'user_cancelled',
        });
    }

    /**
     * Recupera una sesión activa tras recarga de página. Valida que
     * la sesión sigue activa (no cerrada, no expirada). Si la sesión
     * ya no es válida, devuelve un error y emite session_recovery_failed.
     */
    recover({ sessionId } = {}) {
        if (!sessionId) {
            return { ok: false, error: 'session_id required', code: 'SESSION_REQUIRED' };
        }
        const session = this._orderSessionManager.get(sessionId);
        if (!session) {
            this._emit('session_recovery_failed', null, { session_id: sessionId, reason: 'not_found' });
            return { ok: false, error: 'Sesión no encontrada', code: 'SESSION_NOT_FOUND' };
        }
        if (session.session_status === SESSION_STATUS.CLOSED
            || session.session_status === SESSION_STATUS.EXPIRED) {
            this._emit('session_recovery_failed', session, {
                session_id: sessionId,
                reason: 'stale',
                status: session.session_status,
            });
            return { ok: false, error: `Sesión ${session.session_status}`, code: 'STALE_SESSION', session_status: session.session_status };
        }
        session.last_activity_at = new Date().toISOString();
        this._startInactivityTimer(sessionId);
        this._recordAudit(session, 'session_recovered', {});
        this._emit('session_recovered', session, { source: 'frontend_reload' });
        return { ok: true, session };
    }

    /**
     * Asigna un robot a una sesión existente (cambio de robot sin
     * cerrar la sesión). Usado para migración o failover.
     */
    assignRobot(sessionId, robotId) {
        const session = this._orderSessionManager.get(sessionId);
        if (!session) throw new Error(`Sesión no encontrada: ${sessionId}`);
        if ([SESSION_STATUS.CLOSED, SESSION_STATUS.EXPIRED, SESSION_STATUS.COMPLETING].includes(session.session_status)) {
            const error = new Error(`Sesión ${session.session_status}`);
            error.code = 'STALE_SESSION';
            throw error;
        }
        const conflict = this._orderSessionManager.getActiveSessionForRobot(robotId);
        if (conflict && conflict.session_id !== sessionId) {
            throw new Error(`Robot ${robotId} ya tiene sesión activa: ${conflict.session_id}`);
        }
        session.assignment = {
            robot_id: robotId,
            mesa: session.mesa || session.assignment?.mesa || null,
            status: ASSIGNMENT_STATUS.ATTENDING,
            assigned_at: new Date().toISOString(),
        };
        this._recordAudit(session, 'session_assigned', { robot_id: robotId });
        this._emit('session_assigned_to_table', session, { robot_id: robotId });
        return session;
    }

    /**
     * Libera el robot de la sesión sin cerrarla. Útil para handover.
     */
    releaseRobot(sessionId, { reason = 'robot_released' } = {}) {
        const session = this._orderSessionManager.get(sessionId);
        if (!session) return null;
        if ([SESSION_STATUS.CLOSED, SESSION_STATUS.EXPIRED, SESSION_STATUS.COMPLETING].includes(session.session_status)) {
            const error = new Error(`Sesión ${session.session_status}`);
            error.code = 'STALE_SESSION';
            throw error;
        }
        if (!session.assignment) return session;
        const robotId = session.assignment.robot_id;
        this._revokeRobotBootstrapGrants(sessionId);
        session.assignment = {
            ...session.assignment,
            status: ASSIGNMENT_STATUS.RELEASED,
            released_at: new Date().toISOString(),
        };
        this._recordAudit(session, 'robot_released', { reason });
        this._emit('robot_available_for_attention', session, { robot_id: robotId });
        // Notificar liberación física
        if (this._robotTransitionHandler && robotId) {
            try {
                this._robotTransitionHandler({
                    action: 'released',
                    robotId,
                    mesa: session.mesa || null,
                    sessionId,
                });
            } catch (e) {
                this._logger.warn(`[FASE7] robotTransitionHandler error: ${e.message}`);
            }
        }
        return session;
    }

    /**
     * Devuelve todas las sesiones activas (no cerradas, no expiradas).
     */
    listActive() {
        return this._orderSessionManager.listActiveSessions();
    }

    /**
     * Devuelve una ventana acotada de sesiones activas y cerradas para Admin.
     * El historial persistente de pedidos sigue viviendo en PostgreSQL; aquí
     * solo se expone la trazabilidad del ciclo de atención en memoria.
     */
    listAll({ limit = 50 } = {}) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
        return this._orderSessionManager.getAllSessions()
            .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
            .slice(0, safeLimit);
    }

    /**
     * Devuelve el estado serializado de una sesión para inspección.
     */
    snapshot(sessionId) {
        const session = this._orderSessionManager.get(sessionId);
        if (!session) return null;
        return {
            session_id: session.session_id,
            session_status: session.session_status,
            mesa: session.mesa,
            visit_id: session.visit_id || null,
            robot_id: session.robot_id || session.assignment?.robot_id || null,
            guest_count: session.guest_count || null,
            interaction_mode: session.interaction_mode,
            has_memory_profile: Boolean(session.profile_id),
            memory_consent: session.memory_consent || null,
            state: session.state,
            active_order_id: session.active_order_id,
            closed_at: session.closed_at,
            close_reason: session.close_reason,
            last_activity_at: session.last_activity_at,
            draft_count: (session.draft_items || []).length,
        };
    }

    // ── Internos ─────────────────────────────────────────────

    _cancelSessionAudio(reason) {
        if (!this._stopSessionAudio) return;
        try {
            const result = this._stopSessionAudio({ reason });
            if (result && typeof result.catch === 'function') {
                result.catch(error => this._logger.warn?.('[FASE7] Error cancelando audio:', error?.message));
            }
        } catch (error) {
            this._logger.warn?.('[FASE7] Error cancelando audio:', error?.message);
        }
    }

    _notifySessionClosed(session, context = {}) {
        if (!this._sessionClosedHandler) return;
        try {
            const result = this._sessionClosedHandler(session, context);
            if (result && typeof result.catch === 'function') {
                result.catch(error => this._logger.warn?.('[FASE8] Error sincronizando mesa al cerrar sesión:', error?.message));
            }
        } catch (error) {
            this._logger.warn?.('[FASE8] Error sincronizando mesa al cerrar sesión:', error?.message);
        }
    }

    _emit(type, session, extra = {}) {
        if (!this._sendToUI) return;
        try {
            const sessionId = session?.session_id || extra.session_id || null;
            const robotId = session?.assignment?.robot_id || extra.robot_id || null;
            const mesa = session?.mesa || extra.mesa || null;
            const status = session?.session_status || extra.status || null;
            const payload = {
                type,
                session_id: sessionId,
                robot_id: robotId,
                mesa,
                status,
                timestamp: new Date().toISOString(),
                ...extra,
            };
            // Si el session está definido, agregamos el estado serializado.
            if (session && !extra._include_session) {
                payload.session = {
                    session_id: session.session_id,
                    mesa: session.mesa,
                    state: session.state,
                    session_status: session.session_status,
                    interaction_mode: session.interaction_mode,
                    active_order_id: session.active_order_id,
                    visit_id: session.visit_id || null,
                    guest_count: session.guest_count || null,
                };
            }
            this._sendToUI(payload);
        } catch (e) {
            // No bloquear el ciclo por un error de WS.
            this._logger.warn?.(`[FASE7] Error emitiendo ${type}:`, e?.message);
        }
    }

    _recordAudit(session, event, metadata = {}) {
        if (!session) return;
        if (!this._safetyService || typeof this._safetyService.record !== 'function') return;
        this._safetyService.record({
            event,
            sessionId: session.session_id,
            orderId: session.active_order_id,
            mesa: session.mesa,
            actor: 'system',
            source: 'fase7_lifecycle',
            previousState: { session_status: session.session_status },
            nextState: { session_status: session.session_status },
            metadata: {
                ...metadata,
                robot_id: session.assignment?.robot_id || null,
            },
        }).catch(() => {});
    }

    _startInactivityTimer(sessionId) {
        this._clearInactivityTimer(sessionId);
        const session = this._orderSessionManager.get(sessionId);
        if (!session) return;
        if (session.session_status === SESSION_STATUS.CLOSED
            || session.session_status === SESSION_STATUS.EXPIRED) return;
        const warningTimer = setTimeout(() => {
            // Advertencia: la sesión está a punto de cerrarse por inactividad.
            this._recordAudit(session, 'session_timeout_warning', { reason: 'inactivity' });
            this._emit('session_timeout_warning', session, { reason: 'inactivity_warning' });
        }, this._inactivityWarningMs);
        if (typeof warningTimer.unref === 'function') warningTimer.unref();
        this._inactivityWarnings.set(sessionId, warningTimer);
        const closeTimer = setTimeout(() => {
            this._clearInactivityTimer(sessionId);
            this.expireForInactivity(sessionId);
        }, this._inactivityWarningMs + this._inactivityCloseMs);
        if (typeof closeTimer.unref === 'function') closeTimer.unref();
        this._inactivityTimers.set(sessionId, closeTimer);
    }

    _clearInactivityTimer(sessionId) {
        const t1 = this._inactivityTimers.get(sessionId);
        if (t1) { clearTimeout(t1); this._inactivityTimers.delete(sessionId); }
        const t2 = this._inactivityWarnings.get(sessionId);
        if (t2) { clearTimeout(t2); this._inactivityWarnings.delete(sessionId); }
    }

    _createRobotBootstrapGrant(session) {
        const robotId = session.assignment?.robot_id || session.robot_id || null;
        if (!robotId) return null;
        const token = randomUUID();
        this._robotBootstrapGrants.set(token, {
            sessionId: session.session_id,
            robotId,
            expiresAt: Date.now() + ROBOT_BOOTSTRAP_TTL_MS,
        });
        return token;
    }

    _revokeRobotBootstrapGrants(sessionId) {
        for (const [token, grant] of this._robotBootstrapGrants) {
            if (grant.sessionId === sessionId) this._robotBootstrapGrants.delete(token);
        }
    }
}

export {
    SESSION_STATUS,
    ASSIGNMENT_STATUS,
    CLOSE_REASONS,
    generateSessionId,
    ROBOT_BOOTSTRAP_TTL_MS,
    ROBOT_CONNECTION_TTL_MS,
};
