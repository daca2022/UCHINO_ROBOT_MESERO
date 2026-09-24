/**
 * Tests para la entidad de dominio Pedido.
 * Usa node:test nativo de Node.js >= 20.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pedido } from '../../src/domain/Pedido.mjs';

test('Pedido: crea pedido con mesa y platos por defecto', () => {
    const p = new Pedido({ mesa: 'M1', platos: [{ nombre: 'Cafe', cantidad: 2 }] });
    assert.equal(p.mesa, 'M1');
    assert.equal(p.table_id, 'M1');
    assert.equal(p.status, 'draft');
    assert.equal(p.mode, 'tablet');
    assert.equal(p.requires_human, false);
    assert.equal(p.platos.length, 1);
    assert.equal(p.items.length, 1);
    assert.ok(p.id, 'debe tener id generado');
    assert.ok(p.timestamp, 'debe tener timestamp');
});

test('Pedido: acepta contrato canónico del plan HRI', () => {
    const p = new Pedido({
        table_id: 'M2',
        mode: 'voice',
        items: [{ nombre: 'Cafe', cantidad: 1, precio: 5 }],
        subtotal: 5,
        total: 5,
        status: 'pending_confirmation',
        notes: 'sin azucar',
        requires_human: true,
    });

    assert.equal(p.mesa, 'M2');
    assert.equal(p.table_id, 'M2');
    assert.equal(p.mode, 'voice');
    assert.equal(p.status, 'pending_confirmation');
    assert.equal(p.notes, 'sin azucar');
    assert.equal(p.notas, 'sin azucar');
    assert.equal(p.requires_human, true);
    assert.deepEqual(p.platos, p.items);
});

test('Pedido: lanza error si falta mesa', () => {
    assert.throws(
        () => new Pedido({ platos: [] }),
        /mesa es obligatoria/
    );
});

test('Pedido: lanza error si platos no es array', () => {
    assert.throws(
        () => new Pedido({ mesa: 'M1', platos: 'cafe' }),
        /platos debe ser array/
    );
});

test('Pedido: confirmar() cambia estado de provisional a confirmado', () => {
    const p = new Pedido({ mesa: 'M1', platos: [{ nombre: 'Cafe', cantidad: 1 }] });
    assert.equal(p.status, 'draft');
    p.confirmar();
    assert.equal(p.status, 'confirmed');
});

test('Pedido: confirmar() rechaza estados no provisionales', () => {
    const p = new Pedido({ mesa: 'M1', platos: [] });
    p.confirmar();
    assert.throws(() => p.confirmar(), /no se puede confirmar/i);
});

test('Pedido: cancelar() funciona desde cualquier estado excepto entregado/cancelado', () => {
    const p = new Pedido({ mesa: 'M1', platos: [] });
    p.cancelar();
    assert.equal(p.status, 'cancelled');
    assert.throws(() => p.cancelar(), /ya cancelled/);

    const p2 = new Pedido({ mesa: 'M1', platos: [], status: 'delivered' });
    assert.throws(() => p2.cancelar(), /ya delivered/);
});

test('Pedido: calcularTotal() suma precios * cantidades del menu', () => {
    const menu = [
        { nombre: 'Cafe', precio: 5 },
        { nombre: 'Jugo', precio: 8 },
    ];
    const p = new Pedido({
        mesa: 'M1',
        platos: [
            { nombre: 'Cafe', cantidad: 2 },
            { nombre: 'Jugo', cantidad: 1 },
        ],
    });
    p.calcularTotal(menu);
    assert.equal(p.total, 18); // 2*5 + 1*8
});

test('Pedido: calcularTotal() ignora platos que no existen en menu (precio 0)', () => {
    const menu = [{ nombre: 'Cafe', precio: 5 }];
    const p = new Pedido({
        mesa: 'M1',
        platos: [
            { nombre: 'Cafe', cantidad: 1 },
            { nombre: 'Inexistente', cantidad: 3 },
        ],
    });
    p.calcularTotal(menu);
    assert.equal(p.total, 5);
});

test('Pedido: toJSON() expone todos los campos relevantes', () => {
    const p = new Pedido({ mesa: 'M2', platos: [{ nombre: 'Cafe', cantidad: 1 }] });
    const json = p.toJSON();
    assert.equal(json.mesa, 'M2');
    assert.equal(json.table_id, 'M2');
    assert.equal(json.mode, 'tablet');
    assert.equal(json.status, 'draft');
    assert.equal(json.requires_human, false);
    assert.ok(json.id);
    assert.ok(json.timestamp);
    assert.ok(Array.isArray(json.platos));
    assert.ok(Array.isArray(json.items));
});
