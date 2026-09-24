import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Pedido } from '../src/domain/Pedido.mjs';

describe('Pedido — Entidad de Dominio', () => {
    it('debe crear un pedido con estado provisional por defecto', () => {
        const p = new Pedido({ mesa: 'M1', platos: [{ nombre: 'Lomo Saltado', cantidad: 1, precio: 25 }] });
        assert.strictEqual(p.estado, 'provisional');
        assert.strictEqual(p.mesa, 'M1');
        assert.strictEqual(p.platos.length, 1);
    });

    it('debe fallar sin mesa', () => {
        assert.throws(() => new Pedido({ platos: [] }), /mesa es obligatoria/);
    });

    it('debe fallar si platos no es array', () => {
        assert.throws(() => new Pedido({ mesa: 'M1', platos: 'no-array' }), /platos debe ser array/);
    });

    it('debe confirmar un pedido provisional', () => {
        const p = new Pedido({ mesa: 'M2', platos: [{ nombre: 'Ceviche', cantidad: 1 }] });
        p.confirmar();
        assert.strictEqual(p.estado, 'confirmado');
    });

    it('debe fallar al confirmar un pedido ya confirmado', () => {
        const p = new Pedido({ mesa: 'M3', platos: [] });
        p.confirmar();
        assert.throws(() => p.confirmar(), /No se puede confirmar/);
    });

    it('debe cancelar un pedido confirmado', () => {
        const p = new Pedido({ mesa: 'M4', platos: [] });
        p.confirmar();
        p.cancelar();
        assert.strictEqual(p.estado, 'cancelado');
    });

    it('debe fallar al cancelar un pedido entregado', () => {
        const p = new Pedido({ mesa: 'M5', platos: [], estado: 'entregado' });
        assert.throws(() => p.cancelar(), /No se puede cancelar/);
    });

    it('debe calcular total desde el menú', () => {
        const menuItems = [
            { nombre: 'Pollo a la Brasa', precio: 30 },
            { nombre: 'Inca Kola', precio: 5 },
        ];
        const p = new Pedido({
            mesa: 'M6',
            platos: [
                { nombre: 'Pollo a la Brasa', cantidad: 2 },
                { nombre: 'Inca Kola', cantidad: 1 },
            ],
        });
        p.calcularTotal(menuItems);
        assert.strictEqual(p.total, 65); // 2*30 + 1*5
    });

    it('debe serializar a JSON', () => {
        const p = new Pedido({ mesa: 'M7', platos: [{ nombre: 'Tallarines', cantidad: 1 }], total: 20 });
        const json = p.toJSON();
        assert.strictEqual(json.mesa, 'M7');
        assert.strictEqual(json.total, 20);
        assert.ok(json.id);
        assert.ok(json.timestamp);
    });
});
