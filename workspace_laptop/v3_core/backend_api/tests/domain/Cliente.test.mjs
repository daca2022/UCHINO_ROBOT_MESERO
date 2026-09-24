/**
 * Tests para la entidad de dominio Cliente.
 * Usa node:test nativo de Node.js >= 20.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cliente } from '../../src/domain/Cliente.mjs';

test('Cliente: crea con valores por defecto', () => {
    const c = new Cliente({});
    assert.ok(c.id, 'debe tener id generado');
    assert.equal(c.nombre, null);
    assert.deepEqual(c.preferencias, []);
    assert.equal(c.frecuencia, 0);
    assert.equal(c.ultimaVisita, null);
});

test('Cliente: agregarPreferencia() añade sin duplicar', () => {
    const c = new Cliente({});
    c.agregarPreferencia('sin_gluten');
    c.agregarPreferencia('sin_gluten');
    c.agregarPreferencia('café_descafeinado');
    assert.equal(c.preferencias.length, 2);
    assert.ok(c.preferencias.includes('sin_gluten'));
    assert.ok(c.preferencias.includes('café_descafeinado'));
});

test('Cliente: registrarVisita() incrementa frecuencia y guarda timestamp', () => {
    const c = new Cliente({});
    c.registrarVisita('p1');
    assert.equal(c.frecuencia, 1);
    assert.equal(c.historialPedidos.length, 1);
    assert.equal(c.historialPedidos[0], 'p1');
    assert.ok(c.ultimaVisita, 'debe registrar timestamp');

    c.registrarVisita('p2');
    assert.equal(c.frecuencia, 2);
    assert.equal(c.historialPedidos.length, 2);
});

test('Cliente: toJSON() incluye todos los campos públicos', () => {
    const c = new Cliente({ nombre: 'David', preferencias: ['picante'] });
    const json = c.toJSON();
    assert.equal(json.nombre, 'David');
    assert.deepEqual(json.preferencias, ['picante']);
    assert.ok(json.id);
    assert.equal(typeof json.frecuencia, 'number');
});
