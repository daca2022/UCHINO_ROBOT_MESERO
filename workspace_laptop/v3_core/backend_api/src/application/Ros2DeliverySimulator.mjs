import { randomUUID } from 'node:crypto';
import { sanitizeForSpeech } from './SpeechTextSanitizer.mjs';

export const ROS2_TOPIC_CATALOG = Object.freeze([
    { topic: '/uchino/order/confirmed', message_type: 'uchino_msgs/msg/OrderConfirmed' },
    { topic: '/uchino/navigation/goal', message_type: 'geometry_msgs/msg/PoseStamped' },
    { topic: '/uchino/navigation/status', message_type: 'std_msgs/msg/String' },
    { topic: '/uchino/arms/command', message_type: 'uchino_msgs/msg/ArmCommand' },
    { topic: '/uchino/face/expression', message_type: 'std_msgs/msg/String' },
    { topic: '/uchino/speech/text', message_type: 'std_msgs/msg/String' },
    { topic: '/uchino/delivery/status', message_type: 'uchino_msgs/msg/DeliveryStatus' },
]);

export const DELIVERY_STATES = Object.freeze({
    IDLE: 'idle',
    GOING_TO_KITCHEN: 'going_to_kitchen',
    PICKING_UP: 'picking_up',
    GOING_TO_TABLE: 'going_to_table',
    DELIVERING: 'delivering',
    DELIVERED: 'delivered',
    CANCELLED: 'cancelled',
});

const READY_STATUS = 'ready';
const PICKUP_WAIT_SECONDS = 10;
const MAX_EVENTS = 100;
const MAX_ARM_POSITION = Math.PI;
const DEFAULT_ARM_POSITIONS = Object.freeze({
    left: Object.freeze({ dof1: 0.35, dof2: 0.8 }),
    right: Object.freeze({ dof1: -0.35, dof2: 0.8 }),
});

const TIMELINE_STEPS = Object.freeze([
    { state: 'confirmed', label: 'Pedido confirmado' },
    { state: 'preparing', label: 'Cocina preparando' },
    { state: 'ready', label: 'Listo' },
    { state: DELIVERY_STATES.GOING_TO_KITCHEN, label: 'Navegando a cocina' },
    { state: DELIVERY_STATES.PICKING_UP, label: 'Recogiendo' },
    { state: DELIVERY_STATES.GOING_TO_TABLE, label: 'Navegando a mesa' },
    { state: DELIVERY_STATES.DELIVERING, label: 'Entregando' },
    { state: DELIVERY_STATES.DELIVERED, label: 'Completado' },
]);

const TRANSITIONS = Object.freeze({
    [DELIVERY_STATES.GOING_TO_KITCHEN]: [DELIVERY_STATES.PICKING_UP, DELIVERY_STATES.CANCELLED],
    [DELIVERY_STATES.PICKING_UP]: [DELIVERY_STATES.GOING_TO_TABLE, DELIVERY_STATES.CANCELLED],
    [DELIVERY_STATES.GOING_TO_TABLE]: [DELIVERY_STATES.DELIVERING, DELIVERY_STATES.CANCELLED],
    [DELIVERY_STATES.DELIVERING]: [DELIVERY_STATES.DELIVERED, DELIVERY_STATES.CANCELLED],
});

function canonicalStatus(order) {
    const status = order?.status || order?.estado || '';
    return {
        provisional: 'draft',
        confirmado: 'confirmed',
        en_preparacion: 'preparing',
        listo: READY_STATUS,
        entregado: 'delivered',
        cancelado: 'cancelled',
    }[status] || status;
}

function normalizeMesa(value) {
    const raw = String(value || '')
        .trim()
        .toUpperCase()
        .replace(/^MESA\s*/, '')
        .replace(/^M(?=\d)/, '');
    if (!/^([1-9]|1[0-2])$/.test(raw)) {
        throw new Error('La mesa debe tener formato M1 a M12');
    }
    return `M${Number(raw)}`;
}

function itemsFromOrder(order) {
    const items = Array.isArray(order?.items)
        ? order.items
        : Array.isArray(order?.platos)
            ? order.platos
            : [];
    return items.map((item) => ({
        nombre: String(item?.nombre || '').trim(),
        cantidad: Math.max(1, Number(item?.cantidad) || 1),
        precio: Number(item?.precio) || 0,
    })).filter((item) => item.nombre);
}

function cloneArmPositions(positions) {
    return {
        left: { dof1: positions.left.dof1, dof2: positions.left.dof2 },
        right: { dof1: positions.right.dof1, dof2: positions.right.dof2 },
    };
}

function normalizeArmPositions(input = {}) {
    const read = (side, dof) => {
        const raw = input?.[side]?.[dof];
        if (raw === undefined) return DEFAULT_ARM_POSITIONS[side][dof];
        const value = Number(raw);
        if (!Number.isFinite(value) || Math.abs(value) > MAX_ARM_POSITION) {
            throw new Error(`La posición ${side}.${dof} debe ser un número entre -π y π`);
        }
        return value;
    };
    return {
        left: { dof1: read('left', 'dof1'), dof2: read('left', 'dof2') },
        right: { dof1: read('right', 'dof1'), dof2: read('right', 'dof2') },
    };
}

function summarizeOrder(order) {
    let mesa = order.table_id || order.mesa;
    try {
        mesa = normalizeMesa(mesa);
    } catch {
        mesa = String(mesa || '—');
    }
    return {
        id: order.id,
        mesa,
        items: itemsFromOrder(order),
        total: Number(order.total ?? order.subtotal ?? 0),
        timestamp: order.timestamp || null,
        status: canonicalStatus(order),
    };
}

/**
 * Deterministic, Admin-only delivery simulator.
 *
 * It intentionally has no ROS2 socket or child process. A future real adapter
 * can implement `publisher.publish(record)` and be injected explicitly; until
 * then every record is marked `simulated` and remains observable in the UI.
 */
export class Ros2DeliverySimulator {
    constructor({
        pedidoRepo,
        tableService = null,
        notifyEvent = () => {},
        notifyUi = () => {},
        publisher = null,
        logger = console,
        now = () => new Date(),
    }) {
        if (!pedidoRepo) throw new Error('Ros2DeliverySimulator requiere pedidoRepo');
        if (publisher && typeof publisher.publish !== 'function') {
            throw new Error('El publicador ROS 2 debe implementar publish(record)');
        }
        this.pedidoRepo = pedidoRepo;
        this.tableService = tableService;
        this.notifyEvent = notifyEvent;
        this.notifyUi = notifyUi;
        this.publisher = publisher;
        this.logger = logger;
        this.now = now;
        this.active = null;
        this.lastCompleted = null;
        this.events = [];
        this.confirmedOrders = new Set();
        this.mutationPromise = Promise.resolve();
        this.onDeliveryStateChange = null;
        this.onSpeech = null;
    }

    get mode() {
        return this.realAvailable ? 'publisher' : 'simulation';
    }

    get realAvailable() {
        return Boolean(this.publisher?.realAvailable === true);
    }

    setDeliveryStateHandler(handler) {
        this.onDeliveryStateChange = typeof handler === 'function' ? handler : null;
    }

    setSpeechHandler(handler) {
        this.onSpeech = typeof handler === 'function' ? handler : null;
    }

    observeOrderEvent(data) {
        const order = data?.pedido;
        const status = canonicalStatus(order);
        if (!order?.id || !['confirmed', 'sent_to_kitchen'].includes(status)) return null;
        return this.recordOrderConfirmed(order, 'order_flow');
    }

    recordOrderConfirmed(order, origin = 'order_flow') {
        if (!order?.id || this.confirmedOrders.has(order.id)) return null;
        this.confirmedOrders.add(order.id);
        const mesa = normalizeMesa(order.table_id || order.mesa);
        return this.publish(
            '/uchino/order/confirmed',
            {
                order_id: order.id,
                mesa,
                productos: itemsFromOrder(order),
                total: Number(order.total ?? order.subtotal ?? 0),
            },
            origin,
        );
    }

    async getSnapshot() {
        const readyOrders = this.tableService?.listKitchenOrders
            ? await this.tableService.listKitchenOrders({ statuses: [READY_STATUS] })
            : (await this.pedidoRepo.findAll(
                { status: READY_STATUS },
                { orderBy: 'timestamp ASC', limit: 50 },
            )).data;
        return {
            mode: this.mode,
            real_available: this.realAvailable,
            publisher: this.publisher ? 'configured' : 'simulated',
            rosbridge: false,
            pickup_wait_seconds: PICKUP_WAIT_SECONDS,
            topics: ROS2_TOPIC_CATALOG,
            state: this.active?.state || DELIVERY_STATES.IDLE,
            active_order_id: this.active?.order_id || null,
            active: this.active ? this._cloneActive() : null,
            last_completed: this.lastCompleted,
            timeline: this._timeline(),
            events: [...this.events].reverse(),
            ready_orders: readyOrders.map(summarizeOrder),
        };
    }

    async start(orderId, options = {}) {
        return this._runExclusive(() => this._start(orderId, options));
    }

    async _start(orderId, options = {}) {
        if (!orderId) throw new Error('order_id es requerido');
        if (this.active && ![DELIVERY_STATES.DELIVERED, DELIVERY_STATES.CANCELLED].includes(this.active.state)) {
            throw new Error('Ya existe una simulación de entrega activa');
        }

        const order = await this.pedidoRepo.findById(orderId);
        if (!order) throw new Error('Pedido no encontrado');
        if (canonicalStatus(order) !== READY_STATUS) {
            throw new Error('Solo se pueden iniciar entregas para pedidos listos');
        }
        if (this.tableService && !(await this.tableService.isCurrentOrder(order))) {
            throw new Error('El pedido listo no pertenece a una visita activa');
        }

        const mesa = normalizeMesa(order.table_id || order.mesa);
        const startedAt = this.now().toISOString();
        this.active = {
            simulation_id: randomUUID(),
            order_id: order.id,
            visit_id: order.visit_id || null,
            mesa,
            productos: itemsFromOrder(order),
            total: Number(order.total ?? order.subtotal ?? 0),
            state: DELIVERY_STATES.GOING_TO_KITCHEN,
            started_at: startedAt,
            updated_at: startedAt,
            pickup_wait_seconds: PICKUP_WAIT_SECONDS,
            pickup_ready_at: null,
            arm_positions: normalizeArmPositions(options.arm_positions || options.armPositions),
        };

        if (!this.confirmedOrders.has(order.id)) {
            this.recordOrderConfirmed(order, 'admin_simulation_recovery');
        }
        this._publishState('going_to_kitchen', 'admin_simulation');
        this._publishNavigationStatus('going_to_kitchen', 'kitchen', 'admin_simulation');
        this.publish(
            '/uchino/navigation/goal',
            { order_id: order.id, mesa, destination: 'kitchen', frame_id: 'map', simulation: true },
            'admin_simulation',
        );
        this.speak(`Voy a cocina a recoger el pedido de la mesa ${mesa}.`, 'admin_simulation');
        return this.getSnapshot();
    }

    async confirmKitchen(identity) {
        return this._runExclusive(() => {
            this._assertActiveIdentity(identity);
            return this._confirmKitchen();
        });
    }

    async _confirmKitchen() {
        this._requireState(DELIVERY_STATES.GOING_TO_KITCHEN, 'confirmar llegada a cocina');
        this._transitionTo(DELIVERY_STATES.PICKING_UP);
        this.active.pickup_started_at = this.now().toISOString();
        this.active.pickup_ready_at = new Date(this.now().getTime() + PICKUP_WAIT_SECONDS * 1000).toISOString();
        this._publishState('picking_up', 'admin_simulation');
        this._publishNavigationStatus('arrived_at_kitchen', 'kitchen', 'admin_simulation');
        this.publish(
            '/uchino/arms/command',
            {
                order_id: this.active.order_id,
                action: 'raise',
                arms: cloneArmPositions(this.active.arm_positions),
                dof_per_arm: 2,
                simulation: true,
            },
            'admin_simulation',
        );
        return this.getSnapshot();
    }

    async confirmPickup(identity) {
        return this._runExclusive(() => {
            this._assertActiveIdentity(identity);
            return this._confirmPickup();
        });
    }

    async _confirmPickup() {
        this._requireState(DELIVERY_STATES.PICKING_UP, 'confirmar bandeja recogida');
        this._transitionTo(DELIVERY_STATES.GOING_TO_TABLE);
        this._publishState('going_to_table', 'admin_simulation');
        this._publishNavigationStatus('going_to_table', `table_${this.active.mesa}`, 'admin_simulation');
        this.publish(
            '/uchino/navigation/goal',
            {
                order_id: this.active.order_id,
                mesa: this.active.mesa,
                destination: `table_${this.active.mesa}`,
                frame_id: 'map',
                simulation: true,
            },
            'admin_simulation',
        );
        return this.getSnapshot();
    }

    async confirmTable(identity) {
        return this._runExclusive(() => {
            this._assertActiveIdentity(identity);
            return this._confirmTable();
        });
    }

    async _confirmTable() {
        this._requireState(DELIVERY_STATES.GOING_TO_TABLE, 'confirmar llegada a mesa');
        this._transitionTo(DELIVERY_STATES.DELIVERING);
        this._publishState('delivering', 'admin_simulation');
        this._publishNavigationStatus('arrived_at_table', `table_${this.active.mesa}`, 'admin_simulation');
        this.publish(
            '/uchino/arms/command',
            {
                order_id: this.active.order_id,
                action: 'lower',
                arms: {
                    left: { dof1: 0, dof2: 0 },
                    right: { dof1: 0, dof2: 0 },
                },
                dof_per_arm: 2,
                simulation: true,
            },
            'admin_simulation',
        );
        this.publish(
            '/uchino/face/expression',
            { order_id: this.active.order_id, expression: 'feliz', simulation: true },
            'admin_simulation',
        );
        this.speak(
            'Aquí tiene su pedido. Que disfrute su comida. La cuenta será atendida más tarde por un mesero.',
            'admin_simulation',
        );
        return this.getSnapshot();
    }

    async finishDelivery(identity) {
        return this._runExclusive(() => {
            this._assertActiveIdentity(identity);
            return this._finishDelivery();
        });
    }

    async _finishDelivery() {
        if (this.active?.state === DELIVERY_STATES.DELIVERED) return this.getSnapshot();
        this._requireState(DELIVERY_STATES.DELIVERING, 'finalizar entrega');
        if (typeof this.pedidoRepo.updateIfStatus !== 'function') {
            throw new Error('El repositorio no admite transiciones condicionales de entrega');
        }
        const updated = await this.pedidoRepo.updateIfStatus(this.active.order_id, READY_STATUS, { status: 'delivered' });
        if (updated) {
            this._notifyUi({ type: 'pedido_actualizado', pedido: updated });
        } else {
            const current = await this.pedidoRepo.findById(this.active.order_id);
            const status = canonicalStatus(current);
            if (status !== 'delivered') {
                throw new Error(`El pedido ya no está listo para entregar (estado: ${status || 'desconocido'})`);
            }
        }

        this._transitionTo(DELIVERY_STATES.DELIVERED);
        this._publishState('delivered', 'admin_simulation');
        this.lastCompleted = this._cloneActive();
        return this.getSnapshot();
    }

    async cancel(identity) {
        return this._runExclusive(() => {
            this._assertActiveIdentity(identity);
            return this._cancel();
        });
    }

    async _cancel() {
        if (!this.active) throw new Error('No hay una simulación activa');
        if (this.active.state === DELIVERY_STATES.DELIVERED) {
            throw new Error('La simulación ya terminó');
        }
        if (this.active.state !== DELIVERY_STATES.CANCELLED) {
            this._transitionTo(DELIVERY_STATES.CANCELLED);
            this._publishState('cancelled', 'admin_simulation');
        }
        return this.getSnapshot();
    }

    publish(topic, payload, origin = 'admin_simulation') {
        const definition = ROS2_TOPIC_CATALOG.find((candidate) => candidate.topic === topic);
        if (!definition) throw new Error(`Tópico no permitido: ${topic}`);
        const record = {
            id: randomUUID(),
            topic,
            message_type: definition.message_type,
            timestamp: this.now().toISOString(),
            payload,
            publication_state: this.realAvailable ? 'published' : 'simulated',
            origin,
        };

        try {
            const result = this.publisher?.publish?.(record);
            if (result && typeof result.then === 'function') {
                record.publication_state = 'pending';
                Promise.resolve(result).then(
                    (value) => {
                        record.publication_state = value === false
                            ? 'failed'
                            : this.realAvailable ? 'published' : 'simulated';
                        this._notifyEvent(record);
                    },
                    (error) => {
                        record.publication_state = 'failed';
                        record.error = error.message;
                        this.logger.warn('[ROS2 simulator] async publication failed:', error.message);
                        this._notifyEvent(record);
                    },
                );
            } else if (result === false) {
                record.publication_state = 'failed';
            }
        } catch (error) {
            record.publication_state = 'failed';
            record.error = error.message;
            this.logger.warn('[ROS2 simulator] publication failed:', error.message);
        }

        this.events.push(record);
        if (this.events.length > MAX_EVENTS) this.events.shift();
        this._notifyEvent(record);
        return record;
    }

    _notifyEvent(record) {
        try {
            const result = this.notifyEvent(record);
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch((error) => {
                    this.logger.warn('[ROS2 simulator] async UI notification failed:', error.message);
                });
            }
        } catch (error) {
            this.logger.warn('[ROS2 simulator] UI notification failed:', error.message);
        }
    }

    _notifyUi(payload) {
        try {
            const result = this.notifyUi(payload);
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch((error) => {
                    this.logger.warn('[ROS2 simulator] async order notification failed:', error.message);
                });
            }
        } catch (error) {
            this.logger.warn('[ROS2 simulator] order notification failed:', error.message);
        }
    }

    speak(text, origin = 'admin_simulation') {
        const prepared = sanitizeForSpeech(text, { source: 'ros2_simulation' });
        const record = this.publish(
            '/uchino/speech/text',
            {
                // `text` permanece por compatibilidad con el monitor Fase 3;
                // el contrato nuevo separa lo visual de lo hablado.
                text: prepared.displayText,
                display_text: prepared.displayText,
                speech_text: prepared.speechText,
                speech_segments: prepared.segments,
                sanitization: prepared.metadata,
                language: 'es-PE',
                order_id: this.active?.order_id || null,
                simulation: true,
            },
            origin,
        );
        try {
            const result = this.onSpeech?.(record.payload, {
                source: origin,
                orderId: this.active?.order_id || null,
                mesa: this.active?.mesa || null,
            });
            if (result && typeof result.catch === 'function') {
                result.catch(error => this.logger.warn('[ROS2 simulator] speech handler failed:', error.message));
            }
        } catch (error) {
            this.logger.warn('[ROS2 simulator] speech handler failed:', error.message);
        }
        return record;
    }

    _publishState(state, origin) {
        const record = this.publish(
            '/uchino/delivery/status',
            {
                order_id: this.active?.order_id || null,
                visit_id: this.active?.visit_id || null,
                mesa: this.active?.mesa || null,
                state,
                simulation: true,
            },
            origin,
        );
        this._notifyDeliveryStateChange({
            state,
            order_id: this.active?.order_id || null,
            visit_id: this.active?.visit_id || null,
            mesa: this.active?.mesa || null,
            simulation_id: this.active?.simulation_id || null,
            origin,
        });
        return record;
    }

    _notifyDeliveryStateChange(snapshot) {
        if (!this.onDeliveryStateChange) return;
        try {
            const result = this.onDeliveryStateChange(snapshot);
            if (result && typeof result.then === 'function') {
                Promise.resolve(result).catch((error) => this.logger.warn('[ROS2 simulator] table state update failed:', error.message));
            }
        } catch (error) {
            this.logger.warn('[ROS2 simulator] table state update failed:', error.message);
        }
    }

    _publishNavigationStatus(state, destination, origin) {
        return this.publish(
            '/uchino/navigation/status',
            {
                order_id: this.active?.order_id || null,
                mesa: this.active?.mesa || null,
                state,
                destination,
                simulation: true,
            },
            origin,
        );
    }

    _requireState(expected, action) {
        if (!this.active) throw new Error(`No hay una simulación activa para ${action}`);
        if (this.active.state !== expected) {
            throw new Error(`No se puede ${action} desde el estado ${this.active.state}`);
        }
    }

    _runExclusive(operation) {
        const next = this.mutationPromise.then(operation, operation);
        this.mutationPromise = next.catch(() => {});
        return next;
    }

    _assertActiveIdentity(identity) {
        if (!identity?.orderId || !identity?.simulationId) {
            throw new Error('order_id y simulation_id son requeridos');
        }
        if (!this.active || identity.orderId !== this.active.order_id || identity.simulationId !== this.active.simulation_id) {
            throw new Error('La simulación activa no coincide con el pedido solicitado');
        }
    }

    _transitionTo(nextState) {
        const current = this.active?.state;
        if (!current || !TRANSITIONS[current]?.includes(nextState)) {
            throw new Error(`Transición no permitida: ${current || DELIVERY_STATES.IDLE} → ${nextState}`);
        }
        this.active.state = nextState;
        this.active.updated_at = this.now().toISOString();
    }

    _timeline() {
        const current = this.active?.state;
        const currentIndex = TIMELINE_STEPS.findIndex((step) => step.state === current);
        return TIMELINE_STEPS.map((step, index) => ({
            ...step,
            status: current === DELIVERY_STATES.CANCELLED
                ? index < 3 ? 'completed' : 'cancelled'
                : index < currentIndex ? 'completed' : index === currentIndex ? 'current' : 'pending',
        }));
    }

    _cloneActive() {
        if (!this.active) return null;
        return {
            ...this.active,
            productos: this.active.productos.map((item) => ({ ...item })),
            arm_positions: cloneArmPositions(this.active.arm_positions),
        };
    }
}

export { DEFAULT_ARM_POSITIONS, PICKUP_WAIT_SECONDS, TIMELINE_STEPS };
