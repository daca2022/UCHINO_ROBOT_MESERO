/**
 * Tests para PostgresMenuRepository con pool mockeado.
 * No requiere DB real — el pool se inyecta.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresMenuRepository } from '../../src/adapters/PostgresMenuRepository.mjs';

function fakePool() {
    const calls = [];
    const responses = [];
    return {
        _calls: calls,
        _responses: responses,
        _pushResponse: (rows) => responses.push({ rows, rowCount: rows.length }),
        _pushAffected: (n) => responses.push({ rows: [], rowCount: n }),
        query: async (sql, values) => {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
            if (responses.length === 0) {
                throw new Error('fakePool: no response queued');
            }
            return responses.shift();
        },
    };
}

test('MenuRepository.create: inserta con categoria en plural', async () => {
    const pool = fakePool();
    pool._pushResponse([{ id: 'i1', nombre: 'Ceviche', precio: '22.00', categoria: 'platos', disponible: true, imagen_url: null, descripcion: 'Pescado fresco' }]);
    const repo = new PostgresMenuRepository(pool);
    const result = await repo.create({ nombre: 'Ceviche', precio: 22, categoria: 'plato' });
    assert.equal(result.id, 'i1');
    assert.equal(result.categoria, 'plato'); // Devuelve singular
    assert.equal(pool._calls[0].values[3], 'platos'); // Guarda en plural
});

test('MenuRepository.create: rechaza categoria invalida', async () => {
    const pool = fakePool();
    const repo = new PostgresMenuRepository(pool);
    await assert.rejects(
        () => repo.create({ nombre: 'X', precio: 1, categoria: 'snack' }),
        /categoria invalida/
    );
});

test('MenuRepository.create: rechaza sin nombre', async () => {
    const pool = fakePool();
    const repo = new PostgresMenuRepository(pool);
    await assert.rejects(
        () => repo.create({ precio: 1, categoria: 'plato' }),
        /nombre/
    );
});

test('MenuRepository.findById: devuelve entity o null', async () => {
    const pool = fakePool();
    pool._pushResponse([{ id: 'i1', nombre: 'Café', precio: '5.00', categoria: 'bebidas', disponible: true, imagen_url: null, descripcion: null }]);
    const repo = new PostgresMenuRepository(pool);
    const item = await repo.findById('i1');
    assert.equal(item.nombre, 'Café');
    assert.equal(item.categoria, 'bebida'); // singular
    assert.equal(item.precio, 5.0);

    pool._pushResponse([]);
    const none = await repo.findById('missing');
    assert.equal(none, null);
});

test('MenuRepository.findAll: filtra por categoria y ordena', async () => {
    const pool = fakePool();
    // Count
    pool._pushResponse([{ count: '2' }]);
    // Data
    pool._pushResponse([
        { id: 'i1', nombre: 'A', precio: '10', categoria: 'platos', disponible: true, imagen_url: null, descripcion: null },
        { id: 'i2', nombre: 'B', precio: '20', categoria: 'platos', disponible: true, imagen_url: null, descripcion: null },
    ]);
    const repo = new PostgresMenuRepository(pool);
    const result = await repo.findAll({ categoria: 'plato' });
    assert.equal(result.total, 2);
    assert.equal(result.data.length, 2);
    assert.equal(result.data[0].categoria, 'plato');
    // Ambas queries (count + data) deben usar la categoria en plural
    assert.ok(pool._calls[0].values.includes('platos'), 'count query');
    assert.ok(pool._calls[1].values.includes('platos'), 'data query');
});

test('MenuRepository.update: solo acepta campos permitidos', async () => {
    const pool = fakePool();
    pool._pushResponse([{ id: 'i1', nombre: 'Nuevo', precio: '15', categoria: 'platos', disponible: true, imagen_url: null, descripcion: null }]);
    const repo = new PostgresMenuRepository(pool);
    const result = await repo.update('i1', { nombre: 'Nuevo', precio: 15, id_inexistente: 'hack' });
    assert.equal(result.nombre, 'Nuevo');
    // No debe incluir id_inexistente en el SQL
    assert.ok(!pool._calls[0].sql.includes('id_inexistente'));
});

test('MenuRepository.update: devuelve null si nada que actualizar', async () => {
    const pool = fakePool();
    const repo = new PostgresMenuRepository(pool);
    const result = await repo.update('i1', { no_existe: 1 });
    assert.equal(result, null);
});

test('MenuRepository.delete: devuelve true si elimino, false si no', async () => {
    const pool = fakePool();
    pool._pushAffected(1);
    const repo = new PostgresMenuRepository(pool);
    assert.equal(await repo.delete('i1'), true);

    pool._pushAffected(0);
    assert.equal(await repo.delete('i2'), false);
});

test('MenuRepository.healthCheck: true si responde, false si falla', async () => {
    const pool = fakePool();
    pool._pushResponse([{ count: '0' }]);
    const repo = new PostgresMenuRepository(pool);
    assert.equal(await repo.healthCheck(), true);
});
