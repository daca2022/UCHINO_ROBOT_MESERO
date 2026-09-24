import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addModifierToItems,
    deriveSafetyContext,
    addNoteToItems,
    menuQuery,
    removeModifierFromItems,
    removeNoteFromItems,
} from '../../src/application/Fase5Safety.mjs';

const CEVICHE = {
    id: 'ceviche-1',
    nombre: 'Ceviche',
    precio: 22,
    categoria: 'plato',
    informacion_completa: true,
    ingredientes: ['pescado', 'cebolla', 'limón', 'ají', 'sal'],
    alergenos: ['pescado'],
    modificadores_disponibles: [
        { id: 'sin_cebolla', nombre: 'Sin cebolla', tipo: 'remove', ingrediente: 'cebolla' },
        { id: 'poco_sal', nombre: 'Poca sal', tipo: 'level', ingrediente: 'sal', valor: 'low' },
    ],
};

test('separa una unidad modificada y conserva la unidad normal', () => {
    const result = addModifierToItems(
        [{ item_id: 'line-1', product_id: 'ceviche-1', nombre: 'Ceviche', cantidad: 2 }],
        { nombre: 'Ceviche' },
        CEVICHE.modificadores_disponibles[0],
        { quantity: 1, scope: 'one' },
    );
    assert.equal(result.changed, true);
    assert.equal(result.split, true);
    assert.deepEqual(result.items.map(item => [item.nombre, item.cantidad, item.modificaciones.length]), [
        ['Ceviche', 1, 0],
        ['Ceviche', 1, 1],
    ]);
});

test('dos unidades con la misma modificación conservan una línea agregada', () => {
    const result = addModifierToItems(
        [{ item_id: 'line-1', product_id: 'ceviche-1', nombre: 'Ceviche', cantidad: 2 }],
        { nombre: 'Ceviche' },
        CEVICHE.modificadores_disponibles[0],
        { scope: 'all' },
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].cantidad, 2);
    assert.equal(result.items[0].modificaciones[0].id, 'sin_cebolla');
});

test('quitar una modificación no elimina el producto', () => {
    const current = [{ item_id: 'line-1', nombre: 'Ceviche', cantidad: 1, modificaciones: [CEVICHE.modificadores_disponibles[0]] }];
    const result = removeModifierFromItems(current, { nombre: 'Ceviche' }, { id: 'sin_cebolla' });
    assert.equal(result.changed, true);
    assert.equal(result.items[0].nombre, 'Ceviche');
    assert.deepEqual(result.items[0].modificaciones, []);
});

test('quitar una modificación de una unidad separa la unidad normal', () => {
    const current = [{
        item_id: 'line-1', nombre: 'Ceviche', cantidad: 2,
        modificaciones: [CEVICHE.modificadores_disponibles[0]],
    }];
    const result = removeModifierFromItems(current, { nombre: 'Ceviche' }, null, { scope: 'one' });
    assert.equal(result.changed, true);
    assert.deepEqual(result.items.map(item => [item.cantidad, item.modificaciones.length]), [[1, 1], [1, 0]]);
    assert.notEqual(result.items[0].item_id, result.items[1].item_id);
});

test('las observaciones también pueden dirigirse a una sola unidad', () => {
    const added = addNoteToItems(
        [{ item_id: 'line-1', nombre: 'Ceviche', cantidad: 2 }],
        { nombre: 'Ceviche' },
        'sin limón',
        { scope: 'one' },
    );
    assert.deepEqual(added.items.map(item => [item.cantidad, item.observaciones.length]), [[1, 0], [1, 1]]);
    const removed = removeNoteFromItems(added.items, { item_id: added.items[1].item_id }, { scope: 'one' });
    assert.equal(removed.changed, true);
    assert.equal(removed.items.every(item => item.observaciones.length === 0), true);
});

test('alergia contra alérgeno real exige confirmación especial y advierte contaminación cruzada', () => {
    const safety = deriveSafetyContext(
        [{ item_id: 'line-1', nombre: 'Ceviche', cantidad: 1, product_id: 'ceviche-1' }],
        [CEVICHE],
        ['pescado'],
    );
    assert.equal(safety.allergy_conflicts.length, 1);
    assert.equal(safety.requires_special_confirmation, true);
    assert.match(safety.special_warning, /contaminación cruzada/i);
});

test('consulta de ingredientes y alergeno solo usa datos configurados', () => {
    const ingredients = menuQuery([CEVICHE], { productName: 'Ceviche' });
    assert.deepEqual(ingredients.items[0].ingredientes, CEVICHE.ingredientes);
    const allergen = menuQuery([CEVICHE], { allergen: 'pescado' });
    assert.equal(allergen.items[0].nombre, 'Ceviche');
    assert.equal(menuQuery([CEVICHE], { allergen: 'maní' }).items.length, 0);
});

test('las restricciones dietarias desconocidas no se presentan como seguras', () => {
    const safety = deriveSafetyContext(
        [{ item_id: 'line-1', nombre: 'Ceviche', cantidad: 1, product_id: 'ceviche-1' }],
        [{ ...CEVICHE, restricciones: { vegetariano: false, vegano: false, sin_gluten_configurado: false, sin_lactosa_configurado: false } }],
        [],
        ['sin gluten', 'vegetariano'],
    );
    assert.equal(safety.requires_special_confirmation, true);
    assert.equal(safety.incomplete_information.length, 2);
    assert.match(safety.special_warning, /incompleta/i);
});

test('consultas de compatibilidad excluyen fichas incompletas y no inventan seguridad', () => {
    const complete = {
        ...CEVICHE,
        nombre: 'Ensalada',
        id: 'ensalada-1',
        ingredientes: ['lechuga', 'tomate'],
        alergenos: [],
        restricciones: { vegetariano: true, vegano: true, sin_gluten_configurado: true, sin_lactosa_configurado: true },
    };
    const safe = menuQuery([CEVICHE, complete], { allergen: 'maní', safeForAllergen: true });
    assert.deepEqual(safe.items.map(item => item.nombre), ['Ceviche', 'Ensalada']);
    const noSugar = menuQuery([CEVICHE, complete], { excludeIngredient: 'azúcar', category: 'bebidas' });
    assert.equal(noSugar.items.length, 0);
    const dietary = menuQuery([CEVICHE, complete], { restriction: 'vegetariano' });
    assert.deepEqual(dietary.items.map(item => item.nombre), ['Ensalada']);
});

test('conserva la advertencia configurable y exige confirmación por modificador crítico', () => {
    const menuItem = {
        ...CEVICHE,
        advertencia_contaminacion: 'Verificar utensilios separados.',
        modificadores_disponibles: [{
            ...CEVICHE.modificadores_disponibles[0],
            requiere_confirmacion_especial: true,
        }],
    };
    const safety = deriveSafetyContext([{
        item_id: 'line-1', product_id: 'ceviche-1', nombre: 'Ceviche', cantidad: 1,
        modificaciones: [{ id: 'sin_cebolla', requiere_confirmacion_especial: true }],
    }], [menuItem]);
    assert.equal(safety.requires_special_confirmation, true);
    assert.match(safety.special_warning, /utensilios separados/i);
});
