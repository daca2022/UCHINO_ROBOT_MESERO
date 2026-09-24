/**
 * Tests para PostgresPersonalidadRepository (singleton) con pool mockeado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresPersonalidadRepository } from '../../src/adapters/PostgresPersonalidadRepository.mjs';

function fakePool() {
    const calls = [];
    const responses = [];
    return {
        _calls: calls,
        _pushResponse: (rows) => responses.push({ rows, rowCount: rows.length }),
        query: async (sql, values) => {
            calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
            if (responses.length === 0) throw new Error('fakePool: no response queued');
            return responses.shift();
        },
    };
}

test('PersonalidadRepository.get: devuelve fila singleton', async () => {
    const pool = fakePool();
    pool._pushResponse([{
        tono: 'cordial', humor: 'medio', formalidad: 'mixto', proactividad: 'alta', longitud: 'media',
        reglas_contexto: { mesa_ocupada: 'saluda brevemente' },
        updated_at: new Date().toISOString(),
    }]);
    const repo = new PostgresPersonalidadRepository(pool);
    const p = await repo.get();
    assert.equal(p.tono, 'cordial');
    assert.equal(p.humor, 'medio');
    assert.deepEqual(p.reglas_contexto, { mesa_ocupada: 'saluda brevemente' });
});

test('PersonalidadRepository.get: auto-recupera si la fila no existe', async () => {
    const pool = fakePool();
    pool._pushResponse([]); // Primera consulta: no hay fila
    pool._pushResponse([]); // INSERT ... ON CONFLICT no devuelve filas
    pool._pushResponse([{ // Retry
        tono: 'cordial', humor: 'bajo', formalidad: 'usted', proactividad: 'media', longitud: 'corta',
        reglas_contexto: {}, updated_at: new Date().toISOString(),
    }]);
    const repo = new PostgresPersonalidadRepository(pool);
    const p = await repo.get();
    assert.equal(p.tono, 'cordial');
    assert.equal(pool._calls.length, 3);
});

test('PersonalidadRepository.update: solo acepta campos validos', async () => {
    const pool = fakePool();
    pool._pushResponse([{
        tono: 'serio', humor: 'bajo', formalidad: 'usted', proactividad: 'media', longitud: 'corta',
        reglas_contexto: {}, updated_at: new Date().toISOString(),
    }]);
    const repo = new PostgresPersonalidadRepository(pool);
    const result = await repo.update({ tono: 'serio', id: 999, updated_at: 'hack' });
    assert.equal(result.tono, 'serio');
    // El SET del SQL solo debe incluir `tono` (no `id`).
    // (updated_at siempre se actualiza a NOW(), eso es intencional.)
    const sql = pool._calls[0].sql;
    const setClause = sql.split('SET ')[1].split(' WHERE')[0];
    assert.ok(setClause.includes('tono'));
    assert.ok(!setClause.includes('id'));
    // Solo tono en values
    assert.deepEqual(pool._calls[0].values, ['serio']);
});

test('PersonalidadRepository.update: si no hay campos validos, devuelve el estado actual', async () => {
    const pool = fakePool();
    pool._pushResponse([{
        tono: 'cordial', humor: 'bajo', formalidad: 'usted', proactividad: 'media', longitud: 'corta',
        reglas_contexto: {}, updated_at: new Date().toISOString(),
    }]);
    const repo = new PostgresPersonalidadRepository(pool);
    const result = await repo.update({ nada_valido: 1 });
    assert.equal(result.tono, 'cordial');
});

test('PersonalidadRepository.healthCheck: true si la fila existe', async () => {
    const pool = fakePool();
    pool._pushResponse([{ count: '1' }]);
    const repo = new PostgresPersonalidadRepository(pool);
    assert.equal(await repo.healthCheck(), true);
});
