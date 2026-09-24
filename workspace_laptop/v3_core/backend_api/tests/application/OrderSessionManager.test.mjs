import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderSessionManager } from '../../src/application/OrderSessionManager.mjs';

test('el segundo turno de agregar conserva el producto anterior en el mismo draft', () => {
    const manager = new OrderSessionManager({
        menu: [
            { nombre: 'Ceviche', precio: 12, categoria: 'comidas', disponible: true },
            { nombre: 'Suspiro limeño', precio: 6, categoria: 'postres', disponible: true },
        ],
    });
    const session = manager.getOrCreate('fase1-merge', { mesa: 'M1', clientId: 'client-1' });

    manager.setOrderDraft(session.session_id, 'order-1', [
        { nombre: 'Ceviche', cantidad: 1, precio: 12, categoria: 'comidas' },
    ]);

    const result = manager.mergeDraftItems(session.session_id, [
        { nombre: 'Suspiro limeño', cantidad: 1, precio: 6, categoria: 'postres' },
    ], 'Agrega un suspiro limeño');

    assert.deepEqual(result.items.map(({ nombre, cantidad }) => ({ nombre, cantidad })), [
        { nombre: 'Ceviche', cantidad: 1 },
        { nombre: 'Suspiro limeño', cantidad: 1 },
    ]);
    assert.equal(result.order_id, 'order-1');
});

test('quitar elimina solo el producto mencionado y confirma frases con puntuación', () => {
    const manager = new OrderSessionManager({
        menu: [
            { nombre: 'Ceviche', precio: 22, categoria: 'platos', disponible: true },
            { nombre: 'Suspiro limeño', precio: 6, categoria: 'postres', disponible: true },
        ],
    });
    const session = manager.getOrCreate('fase1-remove', { mesa: '1' });
    manager.setOrderDraft(session.session_id, 'order-2', [
        { nombre: 'Ceviche', cantidad: 1 },
        { nombre: 'Suspiro limeño', cantidad: 1 },
    ]);

    const result = manager.mergeDraftItems(session.session_id, [
        { nombre: 'Ceviche', cantidad: 1 },
    ], 'Quita el ceviche.');

    assert.deepEqual(result.items.map(item => item.nombre), ['Suspiro limeño']);
    assert.equal(manager.isConfirmPhrase('Sí, confirma.', session.session_id), true);
});

test('normaliza mesa, actualiza el draft antes de confirmar y bloquea cambios posteriores', () => {
    const manager = new OrderSessionManager({
        menu: [{ nombre: 'Ceviche', precio: 22, categoria: 'platos', disponible: true }],
    });
    const session = manager.getOrCreate('fase1-table', { mesa: '1' });
    manager.setOrderDraft(session.session_id, 'order-3', [{ nombre: 'Ceviche', cantidad: 1 }]);

    manager.updateMesa(session.session_id, 'mesa 8');
    assert.equal(session.mesa, 'M8');
    manager.confirmOrder(session.session_id);
    assert.equal(session.state, 'confirmed');
    assert.throws(() => manager.updateMesa(session.session_id, 'M9'), /no puede cambiar/i);
});

test('cambia un producto por otro aunque el LLM devuelva el producto fuente', () => {
    const manager = new OrderSessionManager({
        menu: [
            { nombre: 'Ceviche', precio: 22, categoria: 'platos', disponible: true },
            { nombre: 'Suspiro limeño', precio: 6, categoria: 'postres', disponible: true },
        ],
    });
    const session = manager.getOrCreate('fase1-change', { mesa: 'M2' });
    manager.setOrderDraft(session.session_id, 'order-4', [{ nombre: 'Ceviche', cantidad: 1, precio: 22 }]);

    const result = manager.mergeDraftItems(session.session_id, [
        { nombre: 'Ceviche', cantidad: 1, precio: 22 },
    ], 'Cambia el ceviche por suspiro limeño');

    assert.deepEqual(result.items.map(item => item.nombre), ['Suspiro limeño']);
    assert.equal(result.total, 6);
});

test('acepta todas las confirmaciones determinísticas requeridas', () => {
    const manager = new OrderSessionManager({
        menu: [{ nombre: 'Ceviche', precio: 22, categoria: 'platos', disponible: true }],
    });

    for (const [index, phrase] of ['Sí', 'confirmo', 'confirma', 'dale', 'correcto'].entries()) {
        const session = manager.getOrCreate(`fase1-confirm-${index}`, { mesa: 'M1' });
        manager.setOrderDraft(session.session_id, `order-confirm-${index}`, [{ nombre: 'Ceviche', cantidad: 1 }]);
        assert.equal(manager.isConfirmPhrase(phrase, session.session_id), true, phrase);
    }
});
