import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService } from '../../../memory_db/src/services/MemoryService.mjs';

function fakeCache() {
    const data = new Map();
    return {
        get: async (key) => data.get(key) || null,
        set: async (key, value) => data.set(key, value),
        del: async (key) => data.delete(key),
    };
}

test('MemoryService: obtenerMenu() expone siempre un array de items', async () => {
    const svc = new MemoryService({
        menuRepo: {
            findAll: async () => ({
                data: [{ id: '1', nombre: 'Cafe', categoria: 'bebida', precio: 5 }],
                total: 1,
            }),
        },
        pedidoRepo: {},
        cache: fakeCache(),
        vectorStore: {},
        logger: { log: () => {} },
    });

    const menu = await svc.obtenerMenu();

    assert.ok(Array.isArray(menu));
    assert.equal(menu.length, 1);
    assert.equal(menu[0].nombre, 'Cafe');
});
