import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DELIVERY_STATES,
    Ros2DeliverySimulator,
} from '../../src/application/Ros2DeliverySimulator.mjs';

function createRepository(initialOrders) {
    const orders = new Map(initialOrders.map((order) => [order.id, structuredClone(order)]));
    const updates = [];
    return {
        updates,
        async findById(id) {
            const order = orders.get(id);
            return order ? structuredClone(order) : null;
        },
        async findAll(filters = {}) {
            const data = [...orders.values()]
                .filter((order) => !filters.status || order.status === filters.status)
                .map((order) => structuredClone(order));
            return { data, total: data.length };
        },
        async update(id, changes) {
            const order = orders.get(id);
            if (!order) return null;
            Object.assign(order, changes);
            updates.push({ id, changes: { ...changes } });
            return structuredClone(order);
        },
        async updateIfStatus(id, expectedStatus, changes) {
            const order = orders.get(id);
            if (!order || order.status !== expectedStatus) return null;
            Object.assign(order, changes);
            updates.push({ id, changes: { ...changes } });
            return structuredClone(order);
        },
    };
}

function readyOrder(id = 'order-ready') {
    return {
        id,
        table_id: 'M8',
        mesa: 'M8',
        items: [{ nombre: 'Ceviche', cantidad: 1, precio: 22 }],
        total: 22,
        status: 'ready',
        timestamp: '2026-07-12T22:00:00.000Z',
    };
}

function createSimulator(repository) {
    const events = [];
    const now = () => new Date('2026-07-12T22:10:00.000Z');
    return {
        events,
        simulator: new Ros2DeliverySimulator({
            pedidoRepo: repository,
            notifyEvent: (event) => events.push(event),
            now,
        }),
    };
}

async function startWithIdentity(simulator, orderId = 'order-ready', options = {}) {
    const snapshot = await simulator.start(orderId, options);
    return {
        snapshot,
        identity: {
            orderId: snapshot.active_order_id,
            simulationId: snapshot.active.simulation_id,
        },
    };
}

test('avanza manualmente una entrega lista y publica el contrato completo', async () => {
    const repository = createRepository([readyOrder()]);
    const { simulator, events } = createSimulator(repository);

    const { snapshot: started, identity } = await startWithIdentity(simulator, 'order-ready', {
        arm_positions: {
            left: { dof1: 1.1, dof2: 1.2 },
            right: { dof1: -1.1, dof2: 1.3 },
        },
    });
    assert.equal(started.state, DELIVERY_STATES.GOING_TO_KITCHEN);

    await simulator.confirmKitchen(identity);
    const raise = events.find((event) => event.topic === '/uchino/arms/command' && event.payload.action === 'raise');
    assert.deepEqual(raise.payload.arms, {
        left: { dof1: 1.1, dof2: 1.2 },
        right: { dof1: -1.1, dof2: 1.3 },
    });
    assert.equal(raise.payload.dof_per_arm, 2);
    assert.ok(events.some((event) => event.topic === '/uchino/navigation/status' && event.payload.state === 'arrived_at_kitchen'));

    await simulator.confirmPickup(identity);
    assert.ok(events.some((event) => event.topic === '/uchino/navigation/status' && event.payload.state === 'going_to_table'));
    await simulator.confirmTable(identity);
    const speech = events.find((event) => event.topic === '/uchino/speech/text');
    assert.equal(speech.payload.text, 'Voy a cocina a recoger el pedido de la mesa M8.');
    const deliverySpeech = events.at(-1);
    assert.equal(deliverySpeech.topic, '/uchino/speech/text');
    assert.equal(deliverySpeech.payload.text, 'Aquí tiene su pedido. Que disfrute su comida. La cuenta será atendida más tarde por un mesero.');

    const snapshot = await simulator.finishDelivery(identity);
    assert.equal(snapshot.state, DELIVERY_STATES.DELIVERED);
    assert.equal(repository.updates.length, 1);
    assert.deepEqual(repository.updates[0], { id: 'order-ready', changes: { status: 'delivered' } });

    for (const event of events) {
        assert.ok(event.topic);
        assert.ok(event.message_type);
        assert.ok(event.timestamp);
        assert.ok(event.payload);
        assert.equal(event.publication_state, 'simulated');
        assert.ok(event.origin);
    }
});

test('rechaza pedidos que no estén listos y transiciones fuera de orden', async () => {
    const repository = createRepository([{ ...readyOrder('order-preparing'), status: 'preparing' }]);
    const { simulator } = createSimulator(repository);

    await assert.rejects(() => simulator.start('order-preparing'), /solo se pueden iniciar/i);
    await assert.rejects(
        () => simulator.confirmKitchen({ orderId: 'order-preparing', simulationId: 'missing-simulation' }),
        /no coincide/i,
    );
});

test('permite cancelar la simulación sin borrar ni cambiar el pedido', async () => {
    const repository = createRepository([readyOrder()]);
    const { simulator } = createSimulator(repository);

    const { identity } = await startWithIdentity(simulator);
    const snapshot = await simulator.cancel(identity);
    assert.equal(snapshot.state, DELIVERY_STATES.CANCELLED);
    assert.equal(repository.updates.length, 0);
});

test('no duplica la publicación de pedido confirmado ni la finalización', async () => {
    const repository = createRepository([readyOrder()]);
    const { simulator, events } = createSimulator(repository);
    const order = await repository.findById('order-ready');

    simulator.recordOrderConfirmed(order);
    simulator.recordOrderConfirmed(order);
    assert.equal(events.filter((event) => event.topic === '/uchino/order/confirmed').length, 1);

    const { identity } = await startWithIdentity(simulator);
    await simulator.confirmKitchen(identity);
    await simulator.confirmPickup(identity);
    await simulator.confirmTable(identity);
    await simulator.finishDelivery(identity);
    const retry = await simulator.finishDelivery(identity);
    assert.equal(retry.state, DELIVERY_STATES.DELIVERED);
    assert.equal(repository.updates.length, 1);
});

test('serializa finalizaciones concurrentes y conserva una sola actualización', async () => {
    const repository = createRepository([readyOrder()]);
    const { simulator } = createSimulator(repository);

    const { identity } = await startWithIdentity(simulator);
    await simulator.confirmKitchen(identity);
    await simulator.confirmPickup(identity);
    await simulator.confirmTable(identity);

    const [first, second] = await Promise.all([
        simulator.finishDelivery(identity),
        simulator.finishDelivery(identity),
    ]);
    assert.equal(first.state, DELIVERY_STATES.DELIVERED);
    assert.equal(second.state, DELIVERY_STATES.DELIVERED);
    assert.equal(repository.updates.length, 1);
});

test('rechaza posiciones de brazos inválidas y publicadores incompletos', async () => {
    const repository = createRepository([readyOrder()]);
    assert.throws(
        () => new Ros2DeliverySimulator({ pedidoRepo: repository, publisher: {} }),
        /debe implementar publish/i,
    );

    const { simulator } = createSimulator(repository);
    await assert.rejects(
        () => simulator.start('order-ready', { arm_positions: { left: { dof1: 99 } } }),
        /entre -π y π/i,
    );
});

test('rechaza una identidad obsoleta sin avanzar otra simulación', async () => {
    const repository = createRepository([readyOrder()]);
    const { simulator } = createSimulator(repository);
    const { snapshot: started, identity } = await startWithIdentity(simulator);

    await assert.rejects(
        () => simulator.confirmKitchen({ orderId: 'another-order', simulationId: identity.simulationId }),
        /no coincide/i,
    );
    assert.equal((await simulator.getSnapshot()).state, DELIVERY_STATES.GOING_TO_KITCHEN);
});

test('serializa cancelación y finalización sin divergir de PostgreSQL', async () => {
    const repository = createRepository([readyOrder()]);
    const { simulator } = createSimulator(repository);
    const { identity } = await startWithIdentity(simulator);
    await simulator.confirmKitchen(identity);
    await simulator.confirmPickup(identity);
    await simulator.confirmTable(identity);

    const [finish, cancel] = await Promise.allSettled([
        simulator.finishDelivery(identity),
        simulator.cancel(identity),
    ]);
    const snapshot = await simulator.getSnapshot();
    const order = await repository.findById('order-ready');
    assert.equal(snapshot.state, DELIVERY_STATES.DELIVERED);
    assert.equal(order.status, 'delivered');
    assert.equal(repository.updates.length, 1);
    assert.equal(finish.status, 'fulfilled');
    assert.equal(cancel.status, 'rejected');
});

test('finaliza aunque falle la notificación de actualización a la UI', async () => {
    const repository = createRepository([readyOrder()]);
    const events = [];
    const simulator = new Ros2DeliverySimulator({
        pedidoRepo: repository,
        notifyEvent: (event) => events.push(event),
        notifyUi: () => { throw new Error('UI no disponible'); },
        now: () => new Date('2026-07-12T22:10:00.000Z'),
        logger: { warn: () => {} },
    });
    const { identity } = await startWithIdentity(simulator);
    await simulator.confirmKitchen(identity);
    await simulator.confirmPickup(identity);
    await simulator.confirmTable(identity);

    const snapshot = await simulator.finishDelivery(identity);
    assert.equal(snapshot.state, DELIVERY_STATES.DELIVERED);
    assert.equal(repository.updates.length, 1);
    assert.ok(events.some((event) => event.payload?.state === 'delivered'));
});

test('registra como fallido un publicador asíncrono rechazado', async () => {
    const repository = createRepository([]);
    const events = [];
    const simulator = new Ros2DeliverySimulator({
        pedidoRepo: repository,
        notifyEvent: (event) => events.push(event),
        publisher: {
            realAvailable: true,
            publish: () => Promise.reject(new Error('ROS2 no disponible')),
        },
        logger: { warn: () => {} },
    });

    const record = simulator.publish('/uchino/delivery/status', { state: 'idle' });
    assert.equal(record.publication_state, 'pending');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(record.publication_state, 'failed');
    assert.equal(events.at(-1).publication_state, 'failed');
});
