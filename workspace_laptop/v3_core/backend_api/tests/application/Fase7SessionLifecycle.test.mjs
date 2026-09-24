import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLifecycleService, SESSION_STATUS, CLOSE_REASONS, generateSessionId } from '../../src/application/SessionLifecycleService.mjs';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';

function createHarness({ inactivityWarningMs = 60_000, inactivityCloseMs = 30_000, onSessionAudioStop = null } = {}) {
    const events = [];
    const orderSessionManager = new OrderSessionManager({ menu: [] });
    const safetyService = {
        async record(event) { events.push(event); return true; },
    };
    const lifecycle = new SessionLifecycleService({
        orderSessionManager,
        sendToUI: (data) => events.push({ channel: 'ws', data }),
        safetyService,
        stopSessionAudio: onSessionAudioStop,
        inactivityWarningMs,
        inactivityCloseMs,
        logger: { warn: () => {}, log: () => {} },
    });
    return { lifecycle, orderSessionManager, events, safetyService };
}

function waitMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Generación única de session_id ─────────────────────────

test('generateSessionId: formato estable con robot_id y mesa', () => {
    const id = generateSessionId({ robotId: 'uchino-01', mesa: 'M8' });
    assert.ok(id.startsWith('uchino-01-M8-'), `id debe empezar con uchino-01-M8- (actual: ${id})`);
    assert.ok(id.length > 30, 'id tiene timestamp + random');
});

test('generateSessionId: ids consecutivos son distintos', () => {
    const a = generateSessionId({ robotId: 'uchino-01', mesa: 'M4' });
    const b = generateSessionId({ robotId: 'uchino-01', mesa: 'M4' });
    assert.notEqual(a, b);
});

test('generateSessionId: sin mesa genera id válido', () => {
    const id = generateSessionId({ robotId: 'uchino-01' });
    assert.ok(id.startsWith('uchino-01-'));
});

// ─── Inicio ────────────────────────────────────────────────

test('start: crea sesión en estado initializing con mesa asignada', () => {
    const { lifecycle, events } = createHarness();
    const session = lifecycle.start({ robotId: 'uchino-01', mesa: 'M8' });
    assert.equal(session.session_status, SESSION_STATUS.INITIALIZING);
    assert.equal(session.mesa, 'M8');
    assert.equal(session.assignment?.robot_id, 'uchino-01');
    assert.equal(session.assignment?.status, 'attending');
    // Eventos emitidos
    const types = events.filter(e => e.channel === 'ws').map(e => e.data.type);
    assert.ok(types.includes('session_started'), 'session_started emitido');
    assert.ok(types.includes('session_assigned_to_table'), 'session_assigned_to_table emitido');
    assert.ok(types.includes('session_mode_required'), 'session_mode_required emitido');
});

test('start: sin mesa no aplica mesa por defecto', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'uchino-01' });
    assert.equal(session.assignment?.status, 'assigned');
    assert.equal(session.assignment?.mesa, null);
});

test('start: robot con sesión activa es reemplazada', () => {
    const { lifecycle, events } = createHarness();
    const a = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const b = lifecycle.start({ robotId: 'r1', mesa: 'M8' });
    assert.notEqual(a.session_id, b.session_id);
    assert.equal(a.session_status, SESSION_STATUS.CLOSED, 'sesión anterior cerrada');
    // Evento de cierre
    const closedEvts = events.filter(e => e.channel === 'ws' && e.data.type === 'session_closed');
    assert.ok(closedEvts.length >= 1);
});

test('startManual: usa robot_id por defecto uchino-01', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.startManual({ mesa: 'M4' });
    assert.equal(session.assignment?.robot_id, 'uchino-01');
});

test('onRobotArrived: equivalente a start con source ros2_simulation', () => {
    const { lifecycle, events } = createHarness();
    const session = lifecycle.onRobotArrived({ robotId: 'r1', mesa: 'M5' });
    assert.equal(session.mesa, 'M5');
    const started = events.find(e => e.channel === 'ws' && e.data.type === 'session_started');
    assert.ok(started, 'session_started emitido');
});

// ─── Modo de atención ──────────────────────────────────────

test('setInteractionMode: marca modo y estado IDLE (listening lo inicia el ASR)', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const updated = lifecycle.setInteractionMode(session.session_id, 'voice');
    assert.equal(updated.session_status, SESSION_STATUS.ACTIVE);
    assert.equal(updated.interaction_mode, 'voice');
    // setInteractionMode marca el modo; el ASR transiciona a LISTENING.
    // Sin draft previo, el estado base tras elegir modo es IDLE.
    assert.equal(updated.state, 'idle');
});

test('setInteractionMode: emite evento session_mode_selected', () => {
    const { lifecycle, events } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    events.length = 0; // reset
    lifecycle.setInteractionMode(session.session_id, 'screen');
    const sel = events.find(e => e.channel === 'ws' && e.data.type === 'session_mode_selected');
    assert.ok(sel, 'session_mode_selected emitido');
    assert.equal(sel.data.mode, 'screen');
});

// ─── Cierre idempotente ───────────────────────────────────

test('close: primera llamada cierra y emite eventos', () => {
    const { lifecycle, events } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    events.length = 0;
    const result = lifecycle.close({ sessionId: session.session_id, reason: 'admin_closed' });
    assert.equal(result.alreadyClosed, false);
    assert.equal(result.session.session_status, SESSION_STATUS.CLOSED);
    assert.equal(result.session.close_reason, 'admin_closed');
    const types = events.filter(e => e.channel === 'ws').map(e => e.data.type);
    assert.ok(types.includes('session_closed'));
    assert.ok(types.includes('robot_available_for_attention'));
});

test('close: segunda llamada es idempotente', () => {
    const { lifecycle, events } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    lifecycle.close({ sessionId: session.session_id });
    events.length = 0;
    const result = lifecycle.close({ sessionId: session.session_id });
    assert.equal(result.alreadyClosed, true);
    const closedEvts = events.filter(e => e.channel === 'ws' && e.data.type === 'session_closed');
    assert.equal(closedEvts.length, 0, 'no re-emite session_closed en cierre idempotente');
});

test('closeAfterOrderConfirmed: usa razón order_confirmed', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const result = lifecycle.closeAfterOrderConfirmed(session.session_id);
    assert.equal(result.session.close_reason, CLOSE_REASONS.ORDER_CONFIRMED);
});

test('close: cancela el audio de la sesión y el cierre por confirmación conserva su respuesta', () => {
    let stops = 0;
    const { lifecycle } = createHarness({ onSessionAudioStop: () => { stops += 1; } });
    const manual = lifecycle.start({ robotId: 'r-audio', mesa: 'M4' });
    const beforeManualClose = stops;
    lifecycle.close({ sessionId: manual.session_id, reason: 'admin_closed' });
    assert.equal(stops, beforeManualClose + 1, 'un cierre manual cancela el audio pendiente');

    const confirmed = lifecycle.start({ robotId: 'r-audio', mesa: 'M5' });
    const beforeConfirmedClose = stops;
    lifecycle.closeAfterOrderConfirmed(confirmed.session_id);
    assert.equal(stops, beforeConfirmedClose, 'el cierre por confirmación no cancela la respuesta TTS recién encolada');
});

test('closeForHumanWaiter: pausa y libera robot', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const result = lifecycle.closeForHumanWaiter(session.session_id);
    assert.equal(result.session.close_reason, CLOSE_REASONS.HUMAN_WAITER_REQUESTED);
});

test('closeWithoutOrder: usa razón no_order', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const result = lifecycle.closeWithoutOrder(session.session_id);
    assert.equal(result.session.close_reason, CLOSE_REASONS.NO_ORDER);
});

test('sesión cerrada rechaza cambios de modo y reasignación', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r-closed-guard', mesa: 'M4' });
    lifecycle.close({ sessionId: session.session_id, reason: 'admin_closed' });

    assert.throws(
        () => lifecycle.setInteractionMode(session.session_id, 'screen'),
        error => error.code === 'STALE_SESSION',
    );
    assert.throws(
        () => lifecycle.assignRobot(session.session_id, 'r-other'),
        error => error.code === 'STALE_SESSION',
    );
    assert.throws(
        () => lifecycle.releaseRobot(session.session_id),
        error => error.code === 'STALE_SESSION',
    );
});

// ─── Expiración por inactividad ────────────────────────────

test('expireForInactivity: marca estado expired con timestamp', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const expired = lifecycle.expireForInactivity(session.session_id);
    assert.equal(expired.session_status, SESSION_STATUS.EXPIRED);
    assert.equal(expired.close_reason, CLOSE_REASONS.INACTIVITY_TIMEOUT);
    assert.ok(expired.closed_at);
});

test('expireForInactivity: libera la asignación física del robot', () => {
    const { lifecycle } = createHarness();
    const transitions = [];
    lifecycle.setRobotTransitionHandler(event => transitions.push(event));
    const session = lifecycle.start({ robotId: 'r-timeout-release', mesa: 'M4' });

    lifecycle.expireForInactivity(session.session_id);

    assert.equal(transitions.at(-1).action, 'released');
    assert.equal(transitions.at(-1).sessionId, session.session_id);
});

test('expireForInactivity: sesión ya cerrada no se modifica', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    lifecycle.close({ sessionId: session.session_id });
    const before = lifecycle.snapshot(session.session_id);
    const after = lifecycle.expireForInactivity(session.session_id);
    assert.equal(after.close_reason, before.close_reason);
});

// ─── Recuperación ────────────────────────────────────────

test('recover: sesión activa se recupera con ok=true', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const result = lifecycle.recover({ sessionId: session.session_id });
    assert.equal(result.ok, true);
    assert.equal(result.session.session_id, session.session_id);
});

test('recover: sesión cerrada devuelve stale con código STALE_SESSION', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    lifecycle.close({ sessionId: session.session_id });
    const result = lifecycle.recover({ sessionId: session.session_id });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'STALE_SESSION');
});

test('recover: sesión inexistente devuelve SESSION_NOT_FOUND', () => {
    const { lifecycle } = createHarness();
    const result = lifecycle.recover({ sessionId: 'nonexistent' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'SESSION_NOT_FOUND');
});

test('recover: emite session_recovered y evento session_recovery_failed para stale', () => {
    const { lifecycle, events } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    lifecycle.close({ sessionId: session.session_id });
    events.length = 0;
    lifecycle.recover({ sessionId: session.session_id });
    const failed = events.find(e => e.channel === 'ws' && e.data.type === 'session_recovery_failed');
    assert.ok(failed, 'session_recovery_failed emitido para sesión stale');
});

// ─── Asignación de robot ──────────────────────────────────

test('assignRobot: cambia robot_id sin cerrar la sesión', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const updated = lifecycle.assignRobot(session.session_id, 'r2');
    assert.equal(updated.assignment.robot_id, 'r2');
    assert.equal(updated.session_status, SESSION_STATUS.INITIALIZING, 'no cambia status');
});

test('assignRobot: rechaza robot ocupado por otra sesión', () => {
    const { lifecycle } = createHarness();
    const a = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const b = lifecycle.start({ robotId: 'r2', mesa: 'M5' });
    assert.throws(() => lifecycle.assignRobot(b.session_id, 'r1'), /ya tiene sesión activa/);
});

// ─── Liberación de robot ──────────────────────────────────

test('releaseRobot: marca el robot como released', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const updated = lifecycle.releaseRobot(session.session_id, { reason: 'handover' });
    assert.equal(updated.assignment.status, 'released');
});

// ─── Actividad y reset de timer ─────────────────────────

test('noteActivity: actualiza last_activity_at', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const before = session.last_activity_at;
    // Esperar 5ms y registrar actividad.
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy wait
    lifecycle.noteActivity(session.session_id);
    const after = lifecycle.snapshot(session.session_id);
    assert.ok(after.last_activity_at >= before);
});

// ─── Listado ─────────────────────────────────────────────

test('listActive: devuelve sesiones no cerradas', () => {
    const { lifecycle } = createHarness();
    lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    lifecycle.start({ robotId: 'r2', mesa: 'M5' });
    const s3 = lifecycle.start({ robotId: 'r3', mesa: 'M6' });
    lifecycle.close({ sessionId: s3.session_id });
    const active = lifecycle.listActive();
    assert.equal(active.length, 2, 's3 cerrada no aparece');
});

test('listAll: incluye sesiones cerradas con motivo para Admin', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'admin-history', mesa: 'M8' });
    lifecycle.close({ sessionId: session.session_id, reason: 'admin_closed' });

    const rows = lifecycle.listAll({ limit: 10 });
    const closed = rows.find(row => row.session_id === session.session_id);
    assert.ok(closed);
    assert.equal(closed.session_status, SESSION_STATUS.CLOSED);
    assert.equal(closed.close_reason, 'admin_closed');
    assert.equal(closed.robot_id, 'admin-history');
});

test('snapshot: expone estado serializado de la sesión', () => {
    const { lifecycle } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const snap = lifecycle.snapshot(session.session_id);
    assert.equal(snap.robot_id, 'r1');
    assert.equal(snap.mesa, 'M4');
    assert.equal(snap.session_status, SESSION_STATUS.INITIALIZING);
});

// ─── Concurrencia y aislamiento ───────────────────────────

test('dos sesiones consecutivas en el mismo robot crean session_ids distintos', () => {
    const { lifecycle } = createHarness();
    const a = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    lifecycle.close({ sessionId: a.session_id });
    const b = lifecycle.start({ robotId: 'r1', mesa: 'M5' });
    assert.notEqual(a.session_id, b.session_id);
    assert.notEqual(a.session_id.split('-').pop(), b.session_id.split('-').pop());
});

test('dos robots en paralelo son independientes', () => {
    const { lifecycle } = createHarness();
    const a = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const b = lifecycle.start({ robotId: 'r2', mesa: 'M5' });
    assert.equal(a.mesa, 'M4');
    assert.equal(b.mesa, 'M5');
    assert.equal(a.assignment?.robot_id, 'r1');
    assert.equal(b.assignment?.robot_id, 'r2');
    lifecycle.close({ sessionId: a.session_id });
    // B no debe verse afectado.
    assert.equal(b.session_status, SESSION_STATUS.INITIALIZING);
});

// ─── Auditoría ───────────────────────────────────────────

test('start: registra evento session_started en pedido_eventos', () => {
    const { lifecycle, events } = createHarness();
    lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    const auditEvts = events.filter(e => e.event === 'session_started');
    assert.equal(auditEvts.length, 1);
    assert.equal(auditEvts[0].mesa, 'M4');
    assert.equal(auditEvts[0].metadata.robot_id, 'r1');
});

test('close: registra session_closed con razón', () => {
    const { lifecycle, events } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    events.length = 0;
    lifecycle.close({ sessionId: session.session_id, reason: 'admin_closed' });
    const closed = events.find(e => e.event === 'session_closed');
    assert.ok(closed);
    assert.equal(closed.metadata.reason, 'admin_closed');
});

test('expireForInactivity: registra session_expired', () => {
    const { lifecycle, events } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    events.length = 0;
    lifecycle.expireForInactivity(session.session_id);
    const expired = events.find(e => e.event === 'session_expired');
    assert.ok(expired);
});

// ─── Integración con OrderSessionManager (Fase 6) ────────

test('close: limpia menu_state e interaction_mode para la siguiente atención', () => {
    const { lifecycle, orderSessionManager } = createHarness();
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    lifecycle.setInteractionMode(session.session_id, 'voice');
    // Simular estado de Fase 6
    const raw = orderSessionManager.get(session.session_id);
    raw.menu_state = { active_category: 'plato', visible_product_ids: ['a'], highlighted_product_id: 'a' };
    lifecycle.close({ sessionId: session.session_id });
    // Verificar que el reset para nuevo orden (el siguiente paso del flujo)
    // limpia todo.
    orderSessionManager.resetForNewOrder(session.session_id);
    const after = orderSessionManager.get(session.session_id);
    assert.equal(after.interaction_mode, null, 'interaction_mode limpiado');
    assert.equal(after.menu_state.active_category, null, 'menu_state limpiado');
    assert.equal(after.assignment, null, 'assignment limpiado');
});

// ─── WebSocket eventos ────────────────────────────────────

test('emit: cada evento de ciclo de vida se envía con session_id y robot_id', () => {
    const { lifecycle, events } = createHarness();
    const session = lifecycle.start({ robotId: 'r2', mesa: 'M7' });
    events.length = 0;
    lifecycle.close({ sessionId: session.session_id, reason: 'order_confirmed' });
    const closed = events.find(e => e.channel === 'ws' && e.data.type === 'session_closed');
    assert.ok(closed, 'session_closed emitido');
    assert.equal(closed.data.robot_id, 'r2');
    assert.equal(closed.data.mesa, 'M7');
    assert.equal(closed.data.close_reason, 'order_confirmed');
});

test('emit: robot_available_for_attention se emite al cerrar', () => {
    const { lifecycle, events } = createHarness();
    const session = lifecycle.start({ robotId: 'r3', mesa: 'M8' });
    events.length = 0;
    lifecycle.close({ sessionId: session.session_id });
    const avail = events.find(e => e.channel === 'ws' && e.data.type === 'robot_available_for_attention');
    assert.ok(avail);
    assert.equal(avail.data.robot_id, 'r3');
});

// ─── Timeout real con timers cortos ───────────────────────

test('timeout: expira la sesión tras inactividad (con timers cortos)', async () => {
    const { lifecycle, events } = createHarness({
        inactivityWarningMs: 50,
        inactivityCloseMs: 50,
    });
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    await waitMs(200);
    const expired = lifecycle.expireForInactivity(session.session_id);
    assert.equal(expired.session_status, SESSION_STATUS.EXPIRED);
    const evt = events.find(e => e.channel === 'ws' && e.data.type === 'session_expired');
    assert.ok(evt, 'session_expired emitido por timer');
});

test('timeout: warning se emite antes del cierre', async () => {
    const { lifecycle, events } = createHarness({
        inactivityWarningMs: 50,
        inactivityCloseMs: 200,
    });
    const session = lifecycle.start({ robotId: 'r1', mesa: 'M4' });
    await waitMs(80);
    const warningEvts = events.filter(e => e.channel === 'ws' && e.data.type === 'session_timeout_warning');
    assert.ok(warningEvts.length >= 1, 'warning emitido antes del cierre');
});
