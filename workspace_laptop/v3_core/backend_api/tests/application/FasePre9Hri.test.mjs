import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';
import { SessionLifecycleService } from '../../src/application/SessionLifecycleService.mjs';
import { WaiterAssistanceService } from '../../src/application/WaiterAssistanceService.mjs';
import { clarificationResponse } from '../../src/routes/asrProcess.mjs';
import { classifyIntent, Intent } from '../../src/application/IntentClassifier.mjs';
import { RobotStateManager, RobotState } from '../../src/application/RobotStateManager.mjs';

test('la sesión conserva tamaño de grupo, visita y robot en el snapshot', () => {
    const manager = new OrderSessionManager({ menu: [] });
    const session = manager.getOrCreate('pref9-session', {
        mesa: 'M8',
        visitId: 'visit-8',
        robotId: 'uchino-01',
        guestCount: 4,
    });

    assert.equal(session.mesa, 'M8');
    assert.equal(session.visit_id, 'visit-8');
    assert.equal(session.robot_id, 'uchino-01');
    assert.equal(session.guest_count, 4);
});

test('SessionLifecycleService propaga guest_count al iniciar una atención', () => {
    const manager = new OrderSessionManager({ menu: [] });
    const lifecycle = new SessionLifecycleService({
        orderSessionManager: manager,
        logger: { warn() {}, log() {} },
    });

    const session = lifecycle.start({
        robotId: 'uchino-01',
        mesa: 'M8',
        visitId: 'visit-8',
        guestCount: 3,
        source: 'qa_pref9',
    });

    assert.equal(session.guest_count, 3);
    assert.equal(lifecycle.snapshot(session.session_id).guest_count, 3);
});

test('la asistencia humana se filtra por sesión, visita, mesa y robot', async () => {
    const waiter = new WaiterAssistanceService({ redis: null, notify() {} });
    await waiter.request({
        session_id: 'session-m1',
        mesa: 'M1',
        table_id: 'M1',
        visit_id: 'visit-m1',
        robot_id: 'uchino-01',
    });
    await waiter.request({
        session_id: 'session-m9',
        mesa: 'M9',
        table_id: 'M9',
        visit_id: 'visit-m9',
        robot_id: 'uchino-01',
    });

    const m9 = await waiter.list({
        status: 'pending',
        tableId: 'M9',
        visitId: 'visit-m9',
        sessionId: 'session-m9',
        robotId: 'uchino-01',
    });
    assert.equal(m9.length, 1);
    assert.equal(m9[0].mesa, 'M9');
    assert.equal(m9[0].visit_id, 'visit-m9');
    assert.equal(m9[0].table_id, 'M9');
});

test('la aclaración general no pregunta por producto cuando no hay intención de mutación', () => {
    assert.match(
        clarificationResponse({ text: '¿Dónde queda el baño?', hasDraft: false, reason: 'unknown' }),
        /menú|precios|ingredientes|ayudarte a elegir/i,
    );
    assert.match(
        clarificationResponse({ text: 'Quiero cambiar algo', hasDraft: true, reason: 'edit' }),
        /producto|cantidad|pantalla|mesero/i,
    );
});

test('las frases de grupo se separan de las cantidades del pedido', () => {
    for (const [text, count] of [['Somos dos', 2], ['Hay cuatro personas', 4], ['mesa para 6', 6], ['Solo uno', 1], ['Somos tres adultos y un niño', 4]]) {
        const result = classifyIntent({ text });
        assert.equal(result.intent, Intent.SET_PARTY_SIZE, text);
        assert.equal(result.entities.guest_count, count, text);
        assert.equal(result.mutates_order, false, text);
    }
});

test('mover una atención draft conserva la sesión y actualiza la mesa del robot', async () => {
    const manager = new OrderSessionManager({ menu: [] });
    const lifecycle = new SessionLifecycleService({
        orderSessionManager: manager,
        logger: { warn() {}, log() {} },
    });
    const transitions = [];
    lifecycle.setRobotTransitionHandler(event => transitions.push(event));
    const session = lifecycle.start({ robotId: 'qa-pref9-robot', mesa: 'M2', visitId: 'visit-m2' });
    const moved = await lifecycle.moveToTable(session.session_id, { mesa: 'M3', visitId: 'visit-m3', source: 'qa' });
    const robot = new RobotStateManager({ robotId: 'qa-pref9-robot' });
    robot.assignToTable({ mesa: 'M2', visitId: 'visit-m2', sessionId: session.session_id, source: 'qa' });
    assert.equal(robot.startNavigatingToTable().state.state, RobotState.NAVIGATING_TO_TABLE);
    assert.equal(robot.arriveAtTable({ mesa: 'M2', visitId: 'visit-m2', sessionId: session.session_id }).state.state, RobotState.ARRIVED_AT_TABLE);
    robot.startAttending({ mesa: 'M2', visitId: 'visit-m2', sessionId: session.session_id });
    const robotMoved = robot.moveAttention({ mesa: moved.mesa, visitId: moved.visit_id, sessionId: moved.session_id });

    assert.equal(moved.mesa, 'M3');
    assert.equal(moved.visit_id, 'visit-m3');
    assert.equal(transitions.at(-1).action, 'moved');
    assert.equal(robotMoved.ok, true);
    assert.equal(robotMoved.state.state, RobotState.ATTENDING);
    assert.equal(robotMoved.state.current_mesa, 'M3');
    assert.equal(robotMoved.state.current_visit_id, 'visit-m3');
});

test('sincroniza la visita persistida después de asignar el robot', () => {
    const robot = new RobotStateManager({ robotId: 'qa-pref9-visit-sync' });
    robot.assignToTable({ mesa: 'M2', sessionId: 'session-visit-sync' });
    robot.startNavigatingToTable();
    robot.arriveAtTable({ mesa: 'M2', sessionId: 'session-visit-sync' });
    robot.startAttending({ mesa: 'M2', sessionId: 'session-visit-sync' });

    const synced = robot.syncAttentionContext({
        mesa: 'M2',
        visitId: 'visit-persisted',
        sessionId: 'session-visit-sync',
    });

    assert.equal(synced.ok, true);
    assert.equal(synced.state.current_visit_id, 'visit-persisted');
    assert.equal(synced.event.metadata.context_sync, true);
});

test('un robot pausado no permite mover la atención a otra mesa', () => {
    const robot = new RobotStateManager({ robotId: 'qa-pref9-pause' });
    robot.assignToTable({ mesa: 'M2', sessionId: 'session-pause' });
    robot.startNavigatingToTable();
    robot.arriveAtTable({ mesa: 'M2', sessionId: 'session-pause' });
    robot.startAttending({ mesa: 'M2', sessionId: 'session-pause' });
    robot.pause({ reason: 'qa' });

    const moved = robot.moveAttention({ mesa: 'M3', sessionId: 'session-pause' });

    assert.equal(moved.ok, false);
    assert.equal(robot.snapshot.current_mesa, 'M2');
});
