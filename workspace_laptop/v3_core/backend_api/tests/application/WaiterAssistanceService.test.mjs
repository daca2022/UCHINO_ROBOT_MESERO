import test from 'node:test';
import assert from 'node:assert/strict';
import { WaiterAssistanceService } from '../../src/application/WaiterAssistanceService.mjs';

test('crea una solicitud de mesero sin pedido y la hace idempotente por sesión', async () => {
    const events = [];
    const service = new WaiterAssistanceService({
        redis: null,
        notify: event => events.push(event),
    });

    const first = await service.request({ session_id: 'waiter-session-1', mesa: 'M8' });
    const second = await service.request({ session_id: 'waiter-session-1', mesa: 'M8' });

    assert.equal(first.created, true);
    assert.equal(first.request.status, 'pending');
    assert.equal(second.created, false);
    assert.equal(second.request.request_id, first.request.request_id);
    assert.equal(events.filter(event => event.event === 'waiter_assistance_requested').length, 1);
    assert.equal(events[0].session_id, 'waiter-session-1');
    assert.equal(events[0].mesa, 'M8');
});

test('lista y atiende solicitudes de forma idempotente', async () => {
    const service = new WaiterAssistanceService({ redis: null, notify: () => {} });
    const { request } = await service.request({ session_id: 'waiter-session-2', mesa: '2' });

    assert.equal((await service.list({ status: 'pending' })).length, 1);
    const attended = await service.attend(request.request_id);
    assert.equal(attended.status, 'attended');
    assert.equal((await service.list({ status: 'pending' })).length, 0);
    assert.equal((await service.list({ status: 'attended' })).length, 1);
    assert.deepEqual(await service.attend(request.request_id), attended);
});

test('dos solicitudes concurrentes de una sesión comparten el mismo request_id', async () => {
    const service = new WaiterAssistanceService();
    const results = await Promise.all([
        service.request({ session_id: 'waiter-concurrent', mesa: 'M8' }),
        service.request({ session_id: 'waiter-concurrent', mesa: 'M8' }),
    ]);
    assert.equal(new Set(results.map(result => result.request.request_id)).size, 1);
    assert.equal(results.filter(result => result.created).length, 1);
});

test('una solicitud expirada no bloquea una nueva solicitud para la misma atención', async () => {
    const now = new Date('2026-07-22T12:00:00.000Z');
    const service = new WaiterAssistanceService({
        redis: null,
        notify: () => {},
        clock: () => new Date(now),
    });
    const first = await service.request({
        session_id: 'waiter-expired-retry',
        mesa: 'M8',
        timestamp: new Date(now.getTime() - 2000).toISOString(),
        expires_at: new Date(now.getTime() - 1000).toISOString(),
    });
    const second = await service.request({
        session_id: 'waiter-expired-retry',
        mesa: 'M8',
    });

    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(second.request.request_id, first.request.request_id);
});
