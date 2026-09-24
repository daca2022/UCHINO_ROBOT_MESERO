/**
 * Tests para CocinaService (KDS - Kitchen Display System).
 * Usa node:test nativo + un fake pedidoRepo y notificador.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CocinaService } from '../../src/application/CocinaService.mjs';

// ─── Fakes ────────────────────────────────────────────────────────────────
function fakePedidoRepo(initial = {}) {
    const data = { ...initial };
    return {
        findById: async (id) => data[id] || null,
        update: async (id, patch) => {
            data[id] = { ...data[id], ...patch };
            return data[id];
        },
        getAll: async () => data,
        _set: (id, p) => { data[id] = p; },
    };
}

function fakeNotificador() {
    const events = [];
    return {
        events,
        emit(channel, payload) { events.push({ channel, payload }); },
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────

test('CocinaService: recibirPedido() cambia sent_to_kitchen -> preparing y emite evento', async () => {
    const repo = fakePedidoRepo();
    repo._set('p1', { id: 'p1', status: 'sent_to_kitchen' });
    const notif = fakeNotificador();
    const svc = new CocinaService({ pedidoRepo: repo, notificador: notif, logger: { log: () => {} } });

    const result = await svc.recibirPedido('p1');
    assert.equal(result.status, 'preparing');
    assert.equal(notif.events.length, 1);
    assert.equal(notif.events[0].channel, 'cocina:pedido_nuevo');
});

test('CocinaService: recibirPedido() rechaza pedido inexistente', async () => {
    const svc = new CocinaService({
        pedidoRepo: fakePedidoRepo(),
        notificador: fakeNotificador(),
        logger: { log: () => {} },
    });
    await assert.rejects(() => svc.recibirPedido('ghost'), /no encontrado/);
});

test('CocinaService: recibirPedido() rechaza pedido que no fue enviado a cocina', async () => {
    const repo = fakePedidoRepo();
    repo._set('p1', { id: 'p1', status: 'confirmed' });
    const svc = new CocinaService({
        pedidoRepo: repo,
        notificador: fakeNotificador(),
        logger: { log: () => {} },
    });
    await assert.rejects(() => svc.recibirPedido('p1'), /no fue enviado a cocina/);
});

test('CocinaService: marcarListo() cambia preparing -> ready', async () => {
    const repo = fakePedidoRepo();
    repo._set('p1', { id: 'p1', status: 'preparing' });
    const notif = fakeNotificador();
    const svc = new CocinaService({ pedidoRepo: repo, notificador: notif, logger: { log: () => {} } });

    const result = await svc.marcarListo('p1');
    assert.equal(result.status, 'ready');
    assert.equal(notif.events[0].channel, 'cocina:pedido_listo');
});

test('CocinaService: marcarListo() rechaza si no está en_preparacion', async () => {
    const repo = fakePedidoRepo();
    repo._set('p1', { id: 'p1', status: 'ready' });
    const svc = new CocinaService({
        pedidoRepo: repo,
        notificador: fakeNotificador(),
        logger: { log: () => {} },
    });
    await assert.rejects(() => svc.marcarListo('p1'), /no está en preparación/);
});

test('CocinaService: entregar() cambia ready -> delivered', async () => {
    const repo = fakePedidoRepo();
    repo._set('p1', { id: 'p1', status: 'ready' });
    const notif = fakeNotificador();
    const svc = new CocinaService({ pedidoRepo: repo, notificador: notif, logger: { log: () => {} } });

    const result = await svc.entregar('p1');
    assert.equal(result.status, 'delivered');
    assert.equal(notif.events[0].channel, 'cocina:pedido_entregado');
});

test('CocinaService: entregar() rechaza si no está listo', async () => {
    const repo = fakePedidoRepo();
    repo._set('p1', { id: 'p1', status: 'preparing' });
    const svc = new CocinaService({
        pedidoRepo: repo,
        notificador: fakeNotificador(),
        logger: { log: () => {} },
    });
    await assert.rejects(() => svc.entregar('p1'), /no está listo/);
});
