import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MemoryService } from '../src/services/MemoryService.mjs';

describe('MemoryService — Lógica de Negocio', () => {
    it('debe usar caché para el menú si existe', async () => {
        let cacheHits = 0;
        let dbHits = 0;

        const svc = new MemoryService({
            menuRepo: {
                findAll: async () => { dbHits++; return [{ nombre: 'Lomo', precio: 25 }]; }
            },
            cache: {
                get: async (key) => {
                    if (key === 'menu:del_dia') { cacheHits++; return JSON.stringify([{ nombre: 'Cached', precio: 99 }]); }
                    return null;
                },
                set: async () => {},
            },
        });

        const menu = await svc.obtenerMenu();
        assert.strictEqual(menu[0].nombre, 'Cached');
        assert.strictEqual(cacheHits, 1);
        assert.strictEqual(dbHits, 0); // No debe tocar DB
    });

    it('debe consultar DB si no hay caché', async () => {
        let dbHits = 0;
        const svc = new MemoryService({
            menuRepo: {
                findAll: async () => { dbHits++; return [{ nombre: 'Lomo', precio: 25 }]; }
            },
            cache: {
                get: async () => null,
                set: async () => {},
            },
        });

        const menu = await svc.obtenerMenu();
        assert.strictEqual(menu[0].nombre, 'Lomo');
        assert.strictEqual(dbHits, 1);
    });

    it('debe invalidar caché de pedidos al crear uno nuevo', async () => {
        let deletedKeys = [];
        const svc = new MemoryService({
            pedidoRepo: {
                create: async (d) => ({ ...d, id: 'p-123' }),
            },
            cache: {
                del: async (key) => deletedKeys.push(key),
            },
        });

        await svc.crearPedido({ mesa: 'M1', platos: [] });
        assert.ok(deletedKeys.includes('pedidos:activos'));
    });

    it('debe devolver healthCheck con todos los estados', async () => {
        const svc = new MemoryService({
            pedidoRepo: { healthCheck: async () => true },
            cache: { ping: async () => 'PONG' },
            vectorStore: { healthCheck: async () => true },
        });

        const health = await svc.healthCheck();
        assert.strictEqual(health.postgresql, true);
        assert.strictEqual(health.redis, true);
        assert.strictEqual(health.chromadb, true);
        assert.strictEqual(health.overall, true);
    });

    it('debe manejar fallo de redis en healthCheck', async () => {
        const svc = new MemoryService({
            pedidoRepo: { healthCheck: async () => true },
            cache: { ping: async () => { throw new Error('down'); } },
        });

        const health = await svc.healthCheck();
        assert.strictEqual(health.postgresql, true);
        assert.strictEqual(health.redis, false);
        assert.strictEqual(health.overall, false);
    });
});
