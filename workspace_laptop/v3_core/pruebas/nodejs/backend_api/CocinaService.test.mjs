import { describe, it } from 'node:test';
import assert from 'node:assert';
import { CocinaService } from '../src/application/CocinaService.mjs';

describe('CocinaService — KDS', () => {
    function crearMockRepo(pedidos = []) {
        return {
            findById: async (id) => pedidos.find(p => p.id === id) || null,
            update: async (id, updates) => {
                const p = pedidos.find(p => p.id === id);
                if (!p) return null;
                Object.assign(p, updates);
                return p;
            },
            findAll: async (filters = {}, options = {}) => {
                let data = pedidos;
                if (filters.estado) data = data.filter(p => p.estado === filters.estado);
                return { data, total: data.length };
            },
        };
    }

    it('debe recibir un pedido confirmado y pasarlo a en_preparacion', async () => {
        const pedidos = [{ id: 'p1', estado: 'confirmado', mesa: 'M1', platos: [] }];
        const notificaciones = [];
        const svc = new CocinaService({
            pedidoRepo: crearMockRepo(pedidos),
            notificador: { emit: (event, data) => notificaciones.push({ event, data }) },
        });

        const res = await svc.recibirPedido('p1');
        assert.strictEqual(res.estado, 'en_preparacion');
        assert.strictEqual(notificaciones[0].event, 'cocina:pedido_nuevo');
    });

    it('debe fallar al recibir un pedido no confirmado', async () => {
        const pedidos = [{ id: 'p2', estado: 'entregado' }];
        const svc = new CocinaService({ pedidoRepo: crearMockRepo(pedidos) });

        await assert.rejects(
            svc.recibirPedido('p2'),
            /no está confirmado/
        );
    });

    it('debe marcar como listo un pedido en preparación', async () => {
        const pedidos = [{ id: 'p3', estado: 'en_preparacion' }];
        const svc = new CocinaService({ pedidoRepo: crearMockRepo(pedidos) });

        const res = await svc.marcarListo('p3');
        assert.strictEqual(res.estado, 'listo');
    });

    it('debe fallar al marcar listo un pedido que no está en preparación', async () => {
        const pedidos = [{ id: 'p4', estado: 'confirmado' }];
        const svc = new CocinaService({ pedidoRepo: crearMockRepo(pedidos) });

        await assert.rejects(
            svc.marcarListo('p4'),
            /no está en preparación/
        );
    });

    it('debe entregar un pedido listo', async () => {
        const pedidos = [{ id: 'p5', estado: 'listo' }];
        const svc = new CocinaService({ pedidoRepo: crearMockRepo(pedidos) });

        const res = await svc.entregar('p5');
        assert.strictEqual(res.estado, 'entregado');
    });

    it('debe obtener cola de cocina', async () => {
        const pedidos = [
            { id: 'p6', estado: 'en_preparacion' },
            { id: 'p7', estado: 'listo' },
            { id: 'p8', estado: 'entregado' },
        ];
        const svc = new CocinaService({ pedidoRepo: crearMockRepo(pedidos) });

        const cola = await svc.obtenerCola();
        assert.strictEqual(cola.en_preparacion.length, 1);
        assert.strictEqual(cola.listos.length, 1);
    });

    it('debe calcular estadísticas', async () => {
        const pedidos = [
            { id: 'p9', estado: 'entregado' },
            { id: 'p10', estado: 'entregado' },
            { id: 'p11', estado: 'en_preparacion' },
        ];
        const svc = new CocinaService({ pedidoRepo: crearMockRepo(pedidos) });

        const stats = await svc.obtenerEstadisticas();
        assert.strictEqual(stats.total, 3);
        assert.strictEqual(stats.entregados, 2);
        assert.strictEqual(stats.en_cola, 1);
        assert.strictEqual(stats.eficiencia, 2 / 3);
    });
});
