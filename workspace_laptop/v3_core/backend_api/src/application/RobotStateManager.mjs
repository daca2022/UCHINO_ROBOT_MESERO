/**
 * RobotStateManager — Fuente única de verdad para el estado físico del robot.
 *
 * Estados: available, assigned, navigating_to_table, arrived_at_table, attending,
 *   waiting_for_human_waiter, going_to_kitchen, picking_up,
 *   going_to_table, delivering, returning, paused,
 *   emergency_stopped, degraded.
 *
 * Reglas:
 * - Solo una tarea física activa a la vez.
 * - No atender otra mesa mientras navega o entrega.
 * - Todos los cambios se auditan (evento robot_state_changed).
 * - waiter_request no bloquea el robot indefinidamente.
 *
 * @module application/RobotStateManager
 */

export const RobotState = Object.freeze({
    AVAILABLE: 'available',
    ASSIGNED: 'assigned',
    NAVIGATING_TO_TABLE: 'navigating_to_table',
    ARRIVED_AT_TABLE: 'arrived_at_table',
    ATTENDING: 'attending',
    WAITING_FOR_HUMAN_WAITER: 'waiting_for_human_waiter',
    GOING_TO_KITCHEN: 'going_to_kitchen',
    PICKING_UP: 'picking_up',
    GOING_TO_TABLE: 'going_to_table',
    DELIVERING: 'delivering',
    RETURNING: 'returning',
    PAUSED: 'paused',
    EMERGENCY_STOPPED: 'emergency_stopped',
    DEGRADED: 'degraded',
});

// Estados que implican movimiento físico
const MOTION_STATES = new Set([
    RobotState.NAVIGATING_TO_TABLE,
    RobotState.GOING_TO_KITCHEN,
    RobotState.PICKING_UP,
    RobotState.GOING_TO_TABLE,
    RobotState.DELIVERING,
    RobotState.RETURNING,
]);

// Estados que implican que el robot está ocupado en una tarea
const BUSY_STATES = new Set([
    RobotState.ASSIGNED,
    RobotState.NAVIGATING_TO_TABLE,
    RobotState.ARRIVED_AT_TABLE,
    RobotState.ATTENDING,
    RobotState.WAITING_FOR_HUMAN_WAITER,
    RobotState.GOING_TO_KITCHEN,
    RobotState.PICKING_UP,
    RobotState.GOING_TO_TABLE,
    RobotState.DELIVERING,
    RobotState.RETURNING,
    RobotState.PAUSED,
]);

// Estados desde los cuales se puede iniciar una nueva atención
const CAN_START_ATTENTION = new Set([
    RobotState.AVAILABLE,
    RobotState.ATTENDING, // continuar o adicional en misma mesa
]);

/**
 * Etiquetas legibles para cada estado (frontend-ready).
 */
export const ROBOT_STATE_LABELS = Object.freeze({
    [RobotState.AVAILABLE]: 'Disponible',
    [RobotState.ASSIGNED]: 'Asignado',
    [RobotState.NAVIGATING_TO_TABLE]: 'En camino a mesa',
    [RobotState.ARRIVED_AT_TABLE]: 'Llegó a mesa',
    [RobotState.ATTENDING]: 'Atendiendo',
    [RobotState.WAITING_FOR_HUMAN_WAITER]: 'Esperando mesero',
    [RobotState.GOING_TO_KITCHEN]: 'En camino a cocina',
    [RobotState.PICKING_UP]: 'Recogiendo pedido',
    [RobotState.GOING_TO_TABLE]: 'En camino a mesa',
    [RobotState.DELIVERING]: 'Entregando',
    [RobotState.RETURNING]: 'Regresando',
    [RobotState.PAUSED]: 'Pausado',
    [RobotState.EMERGENCY_STOPPED]: 'Emergencia detenida',
    [RobotState.DEGRADED]: 'Degradado',
});

/**
 * Colores para cada estado (frontend-ready).
 */
export const ROBOT_STATE_COLORS = Object.freeze({
    [RobotState.AVAILABLE]: '#10B981',
    [RobotState.ASSIGNED]: '#3B82F6',
    [RobotState.NAVIGATING_TO_TABLE]: '#8B5CF6',
    [RobotState.ARRIVED_AT_TABLE]: '#06B6D4',
    [RobotState.ATTENDING]: '#F59E0B',
    [RobotState.WAITING_FOR_HUMAN_WAITER]: '#F97316',
    [RobotState.GOING_TO_KITCHEN]: '#6366F1',
    [RobotState.PICKING_UP]: '#A855F7',
    [RobotState.GOING_TO_TABLE]: '#8B5CF6',
    [RobotState.DELIVERING]: '#EC4899',
    [RobotState.RETURNING]: '#14B8A6',
    [RobotState.PAUSED]: '#FCD34D',
    [RobotState.EMERGENCY_STOPPED]: '#EF4444',
    [RobotState.DEGRADED]: '#9CA3AF',
});

export class RobotStateManager {
    /**
     * @param {object} options
     * @param {string} options.robotId - ID del robot
     * @param {function} [options.onStateChange] - callback(prevState, newState, event)
     * @param {object} [options.logger] - logger
     */
    constructor({ robotId = 'uchino-01', onStateChange = null, logger = null } = {}) {
        this._robotId = robotId;
        this._onStateChange = onStateChange;
        this._logger = logger || { log: () => {}, warn: () => {}, error: () => {} };
        this._state = {
            robot_id: robotId,
            state: RobotState.AVAILABLE,
            previous_state: null,
            current_mesa: null,
            current_visit_id: null,
            current_session_id: null,
            current_order_id: null,
            current_task: null,
            assignment_id: null,
            changed_at: new Date().toISOString(),
            history: [],
        };
    }

    get robotId() { return this._robotId; }
    get state() { return this._state.state; }
    get snapshot() { return { ...this._state, history: [...this._state.history] }; }
    get isAvailable() { return this._state.state === RobotState.AVAILABLE; }
    get isInMotion() { return MOTION_STATES.has(this._state.state); }
    get isBusy() { return BUSY_STATES.has(this._state.state); }

    canStartAttention() {
        return CAN_START_ATTENTION.has(this._state.state);
    }

    canAcceptNewOrder() {
        return !this.isInMotion && this._state.state !== RobotState.EMERGENCY_STOPPED;
    }

    canNavigate() {
        return ![RobotState.EMERGENCY_STOPPED, RobotState.DEGRADED].includes(this._state.state);
    }

    canConversate() {
        return this._state.state !== RobotState.EMERGENCY_STOPPED;
    }

    /**
     * Transiciona a un nuevo estado con validación.
     * Retorna { ok, state, error }.
     */
    transition(newState, metadata = {}) {
        const prevState = { ...this._state };

        if (!Object.values(RobotState).includes(newState)) {
            return { ok: false, state: prevState, error: `Unknown robot state: ${newState}` };
        }

        // Validar que la transición es válida
        const validation = this._validateTransition(prevState.state, newState, metadata);
        if (!validation.ok) {
            this._logger.warn(`[RobotStateManager] Transición inválida: ${prevState.state} → ${newState}: ${validation.error}`);
            return { ok: false, state: prevState, error: validation.error };
        }

        // Aplicar transición
        const event = {
            event_type: 'robot_state_changed',
            robot_id: this._robotId,
            previous_state: prevState.state,
            new_state: newState,
            mesa: metadata.mesa !== undefined ? metadata.mesa : prevState.current_mesa,
            visit_id: metadata.visit_id !== undefined ? metadata.visit_id : prevState.current_visit_id,
            session_id: metadata.session_id !== undefined ? metadata.session_id : prevState.current_session_id,
            order_id: metadata.order_id !== undefined ? metadata.order_id : prevState.current_order_id,
            timestamp: new Date().toISOString(),
            metadata,
        };

        this._state = {
            ...this._state,
            state: newState,
            previous_state: prevState.state,
            current_mesa: metadata.mesa !== undefined ? metadata.mesa : prevState.current_mesa,
            current_visit_id: metadata.visit_id !== undefined ? metadata.visit_id : prevState.current_visit_id,
            current_session_id: metadata.session_id !== undefined ? metadata.session_id : prevState.current_session_id,
            current_order_id: metadata.order_id !== undefined ? metadata.order_id : prevState.current_order_id,
            current_task: Object.prototype.hasOwnProperty.call(metadata, 'task')
                ? metadata.task
                : prevState.current_task,
            assignment_id: metadata.assignment_id !== undefined ? metadata.assignment_id : prevState.assignment_id,
            changed_at: event.timestamp,
        };

        // Registrar en historial (máximo 100 entradas)
        this._state.history.push(event);
        if (this._state.history.length > 100) {
            this._state.history = this._state.history.slice(-100);
        }

        if (this._onStateChange) {
            this._onStateChange(prevState, { ...this._state }, event);
        }

        this._logger.log(`[RobotStateManager] ${prevState.state} → ${newState} ${metadata.mesa ? `(mesa ${metadata.mesa})` : ''}`);
        return { ok: true, state: { ...this._state }, event };
    }

    /**
     * Asigna el robot a una mesa.
     */
    assignToTable({ mesa, visitId, sessionId, source = 'admin' }) {
        return this.transition(RobotState.ASSIGNED, {
            mesa,
            visit_id: visitId,
            session_id: sessionId,
            assignment_id: `asgn_${Date.now()}`,
            source,
            task: `Atender mesa ${mesa}`,
        });
    }

    /**
     * Inicia navegación hacia la mesa.
     */
    startNavigatingToTable() {
        return this.transition(RobotState.NAVIGATING_TO_TABLE, {
            task: 'Navegando a la mesa',
        });
    }

    arriveAtTable({ mesa, visitId, sessionId }) {
        return this.transition(RobotState.ARRIVED_AT_TABLE, {
            mesa,
            visit_id: visitId,
            session_id: sessionId,
            task: `Llegó a mesa ${mesa}`,
        });
    }

    /**
     * Llegó a la mesa, comienza atención.
     */
    startAttending({ mesa, visitId, sessionId }) {
        return this.transition(RobotState.ATTENDING, {
            mesa,
            visit_id: visitId,
            session_id: sessionId,
            task: `Atendiendo mesa ${mesa}`,
        });
    }

    moveAttention({ mesa, visitId, sessionId }) {
        const validation = this.canMoveAttention({ mesa, sessionId });
        if (!validation.ok) return validation;
        return this.transition(RobotState.ATTENDING, {
            mesa,
            visit_id: visitId,
            session_id: sessionId,
            task: `Atendiendo mesa ${mesa}`,
            reassigned: true,
        });
    }

    canMoveAttention({ sessionId, mesa } = {}) {
        if ([RobotState.PAUSED, RobotState.EMERGENCY_STOPPED, RobotState.DEGRADED].includes(this._state.state)) {
            return { ok: false, state: this.snapshot, error: `Robot no puede cambiar de mesa desde ${this._state.state}` };
        }
        if (sessionId && this._state.current_session_id && this._state.current_session_id !== sessionId) {
            return { ok: false, state: this.snapshot, error: 'La atención pertenece a otra sesión.' };
        }
        if (this._state.state !== RobotState.ATTENDING) {
            return { ok: false, state: this.snapshot, error: `Robot no está atendiendo: ${this._state.state}` };
        }
        if (mesa && this._state.current_mesa === mesa) {
            return { ok: true, state: this.snapshot };
        }
        return { ok: true, state: this.snapshot };
    }

    syncAttentionContext({ mesa, visitId, sessionId }) {
        if (!BUSY_STATES.has(this._state.state)) {
            return { ok: false, state: this.snapshot, error: `Robot no está atendiendo: ${this._state.state}` };
        }
        return this.transition(this._state.state, {
            mesa,
            visit_id: visitId,
            session_id: sessionId,
            context_sync: true,
            reassigned: this._state.state === RobotState.ATTENDING,
        });
    }

    /**
     * Esperando mesero humano.
     */
    waitForHumanWaiter({ mesa, visitId = null, sessionId }) {
        return this.transition(RobotState.WAITING_FOR_HUMAN_WAITER, {
            mesa,
            visit_id: visitId,
            session_id: sessionId,
            task: 'Esperando mesero humano',
        });
    }

    /**
     * Va a cocina a recoger pedido.
     */
    goToKitchen({ orderId, mesa }) {
        return this.transition(RobotState.GOING_TO_KITCHEN, {
            order_id: orderId,
            mesa,
            task: `Yendo a cocina por pedido de mesa ${mesa}`,
        });
    }

    /**
     * Recogiendo pedido en cocina.
     */
    startPickingUp({ orderId, mesa }) {
        return this.transition(RobotState.PICKING_UP, {
            order_id: orderId,
            mesa,
            task: `Recogiendo pedido para mesa ${mesa}`,
        });
    }

    /**
     * Navegando hacia la mesa para entregar.
     */
    goToTableForDelivery({ orderId, mesa }) {
        return this.transition(RobotState.GOING_TO_TABLE, {
            order_id: orderId,
            mesa,
            task: `Llevando pedido a mesa ${mesa}`,
        });
    }

    /**
     * Entregando en la mesa.
     */
    startDelivering({ orderId, mesa }) {
        return this.transition(RobotState.DELIVERING, {
            order_id: orderId,
            mesa,
            task: `Entregando pedido en mesa ${mesa}`,
        });
    }

    /**
     * Regresando a base.
     */
    startReturning() {
        return this.transition(RobotState.RETURNING, {
            mesa: null,
            task: 'Regresando a punto de espera',
        });
    }

    /**
     * Pausa la navegación.
     */
    pause({ reason = 'user_request' } = {}) {
        const validFrom = new Set([
            RobotState.NAVIGATING_TO_TABLE,
            RobotState.GOING_TO_KITCHEN,
            RobotState.PICKING_UP,
            RobotState.GOING_TO_TABLE,
            RobotState.DELIVERING,
            RobotState.RETURNING,
            RobotState.ATTENDING,
        ]);
        if (!validFrom.has(this._state.state)) {
            return { ok: false, state: { ...this._state }, error: `Cannot pause from state ${this._state.state}` };
        }
        return this.transition(RobotState.PAUSED, { task: `Pausado: ${reason}`, reason });
    }

    /**
     * Reanuda desde pausa al estado anterior.
     */
    resume() {
        if (this._state.state !== RobotState.PAUSED) {
            return { ok: false, state: { ...this._state }, error: 'Robot is not paused' };
        }
        const resumeTo = this._state.previous_state || RobotState.AVAILABLE;
        return this.transition(resumeTo, {
            task: this._state.current_task?.replace('Pausado: ', ''),
            resumed_from_pause: true,
        });
    }

    /**
     * Emergencia detenida.
     */
    emergencyStop({ reason = 'manual' } = {}) {
        return this.transition(RobotState.EMERGENCY_STOPPED, {
            task: `EMERGENCIA: ${reason}`,
            reason,
        });
    }

    /**
     * Libera el robot (vuelve a available).
     */
    release({ reason = 'task_completed' } = {}) {
        return this.transition(RobotState.AVAILABLE, {
            mesa: null,
            visit_id: null,
            session_id: null,
            order_id: null,
            task: null,
            assignment_id: null,
            reason,
        });
    }

    /**
     * Marca como degradado (fallo parcial).
     */
    markDegraded({ reason } = {}) {
        return this.transition(RobotState.DEGRADED, {
            task: `Degradado: ${reason || 'fallo no especificado'}`,
            reason,
        });
    }

    // ── Validación interna ──────────────────────────────────────────────
    _validateTransition(from, to, metadata) {
        // Transiciones siempre permitidas
        const alwaysAllowed = new Set([
            RobotState.EMERGENCY_STOPPED,
            RobotState.DEGRADED,
        ]);
        if (alwaysAllowed.has(to)) return { ok: true };

        // Desde emergencia solo se puede ir a available (tras revisión manual)
        if (from === RobotState.EMERGENCY_STOPPED) {
            if (to === RobotState.AVAILABLE || to === RobotState.DEGRADED) return { ok: true };
            return { ok: false, error: 'Must be manually released from emergency stop' };
        }

        // Desde degradado solo available
        if (from === RobotState.DEGRADED) {
            if (to === RobotState.AVAILABLE) return { ok: true };
            return { ok: false, error: 'Robot is degraded' };
        }

        // Pausa → reanudación solo vía resume()
        if (from === RobotState.PAUSED && to !== RobotState.PAUSED) {
            if (to === RobotState.AVAILABLE && metadata.reason) return { ok: true };
            // resume() already handles this, but direct transition should be blocked
            if (!metadata.resumed_from_pause) {
                return { ok: false, error: 'Use resume() to unpause' };
            }
            return { ok: true };
        }

        // No iniciar navegación si ya está en movimiento
        if (MOTION_STATES.has(from) && MOTION_STATES.has(to) && from !== to) {
            // Permitir transiciones en la cadena de entrega
            const deliveryChain = [
                RobotState.GOING_TO_KITCHEN,
                RobotState.PICKING_UP,
                RobotState.GOING_TO_TABLE,
                RobotState.DELIVERING,
                RobotState.RETURNING,
                RobotState.AVAILABLE,
            ];
            const fromIdx = deliveryChain.indexOf(from);
            const toIdx = deliveryChain.indexOf(to);
            if (fromIdx >= 0 && toIdx > fromIdx) return { ok: true };
            return { ok: false, error: `Already in motion (${from}), cannot transition to ${to}` };
        }

        // No iniciar atención si ya está atendiendo otra mesa
        if (from === RobotState.ATTENDING && to === RobotState.ATTENDING) {
            if (metadata.reassigned) return { ok: true };
            if (metadata.mesa && metadata.mesa !== this._state.current_mesa) {
                return { ok: false, error: `Already attending mesa ${this._state.current_mesa}` };
            }
        }

        return { ok: true };
    }
}
