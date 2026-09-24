import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';
import { SessionLifecycleService } from '../../src/application/SessionLifecycleService.mjs';
import { createSessionsRouter } from '../../src/routes/sessions.mjs';
import { projectUiEvent } from '../../src/application/UiEventProjection.mjs';

function createLifecycle() {
  const manager = new OrderSessionManager({ menu: [] });
  const lifecycle = new SessionLifecycleService({
    orderSessionManager: manager,
    logger: { warn() {}, log() {} },
  });
  return { manager, lifecycle };
}

test('Fase 13: el handoff de robot se canjea una sola vez y no entrega el token por WS', () => {
  const { lifecycle } = createLifecycle();
  const connection = lifecycle.registerRobotConnection({ robotId: 'uchino-01', connectionId: 'qa-robot' });
  const session = lifecycle.start({ robotId: 'uchino-01', mesa: 'M1', source: 'admin' });
  const grant = lifecycle.getRobotBootstrapGrant({ robotId: 'uchino-01', sessionId: session.session_id });

  assert.ok(grant?.robot_bootstrap_token);
  assert.equal(grant.session_id, session.session_id);
  assert.equal(Object.hasOwn(grant, 'session_access_token'), false);

  const wrongRobot = lifecycle.redeemRobotBootstrap({
    sessionId: session.session_id,
    robotId: 'otro-robot',
    bootstrapToken: grant.robot_bootstrap_token,
    robotConnectionToken: connection.robot_connection_token,
  });
  assert.equal(wrongRobot.ok, false);
  assert.equal(wrongRobot.code, 'ROBOT_CONNECTION_REQUIRED');

  const redeemed = lifecycle.redeemRobotBootstrap({
    sessionId: session.session_id,
    robotId: 'uchino-01',
    bootstrapToken: grant.robot_bootstrap_token,
    robotConnectionToken: connection.robot_connection_token,
  });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.session.session_access_token, session.session_access_token);

  const replay = lifecycle.redeemRobotBootstrap({
    sessionId: session.session_id,
    robotId: 'uchino-01',
    bootstrapToken: grant.robot_bootstrap_token,
    robotConnectionToken: connection.robot_connection_token,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'INVALID_ROBOT_BOOTSTRAP');
});

test('Fase 13: la ruta robot-bootstrap entrega snapshot autorizado y rechaza replay', async () => {
  const { manager, lifecycle } = createLifecycle();
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createSessionsRouter(lifecycle, manager));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const started = await fetch(`${base}/api/sessions/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ robot_id: 'uchino-01', mesa: 'M1', source: 'manual' }),
    });
    const startedBody = await started.json();
    assert.equal(started.status, 201);
    const grant = lifecycle.getRobotBootstrapGrant({
      robotId: 'uchino-01',
      sessionId: startedBody.session_id,
    });
    const connection = lifecycle.registerRobotConnection({ robotId: 'uchino-01', connectionId: 'qa-route' });

    const missingConnection = await fetch(`${base}/api/sessions/${startedBody.session_id}/robot-bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ robot_id: 'uchino-01', bootstrap_token: grant.robot_bootstrap_token }),
    });
    assert.equal(missingConnection.status, 401);

    const claimed = await fetch(`${base}/api/sessions/${startedBody.session_id}/robot-bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        robot_id: 'uchino-01',
        bootstrap_token: grant.robot_bootstrap_token,
        robot_connection_token: connection.robot_connection_token,
      }),
    });
    const claimedBody = await claimed.json();
    assert.equal(claimed.status, 200);
    assert.equal(claimedBody.ok, true);
    assert.ok(claimedBody.session.session_access_token);

    const replay = await fetch(`${base}/api/sessions/${startedBody.session_id}/robot-bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        robot_id: 'uchino-01',
        bootstrap_token: grant.robot_bootstrap_token,
        robot_connection_token: connection.robot_connection_token,
      }),
    });
    assert.equal(replay.status, 401);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Fase 13: el grant efímero solo se proyecta al cliente público del robot', () => {
  const event = {
    type: 'robot_session_bootstrap',
    session_id: 'session-handoff',
    robot_id: 'uchino-01',
    robot_bootstrap_token: 'grant-only',
    robot_connection_token: 'connection-only',
    session_access_token: 'private-session-token',
  };
  const publicEvent = projectUiEvent(event);
  assert.equal(publicEvent.robot_bootstrap_token, 'grant-only');
  assert.equal(publicEvent.robot_connection_token, 'connection-only');
  assert.equal(Object.hasOwn(publicEvent, 'session_access_token'), false);

  const adminEvent = projectUiEvent(event, { role: 'admin' });
  assert.equal(Object.hasOwn(adminEvent, 'robot_bootstrap_token'), false);
  assert.equal(Object.hasOwn(adminEvent, 'robot_connection_token'), false);
  assert.equal(Object.hasOwn(adminEvent, 'session_access_token'), false);
});

test('Fase 13: liberar robot invalida el grant de bootstrap pendiente', () => {
  const { lifecycle } = createLifecycle();
  const connection = lifecycle.registerRobotConnection({ robotId: 'uchino-01', connectionId: 'qa-release' });
  const session = lifecycle.start({ robotId: 'uchino-01', mesa: 'M1', source: 'manual' });
  const grant = lifecycle.getRobotBootstrapGrant({ robotId: 'uchino-01', sessionId: session.session_id });

  lifecycle.releaseRobot(session.session_id);
  const result = lifecycle.redeemRobotBootstrap({
    sessionId: session.session_id,
    robotId: 'uchino-01',
    bootstrapToken: grant.robot_bootstrap_token,
    robotConnectionToken: connection.robot_connection_token,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ROBOT_BOOTSTRAP');
});
