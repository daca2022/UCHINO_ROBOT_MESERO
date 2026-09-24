import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, Intent } from '../../src/application/IntentClassifier.mjs';

const MENU = [{
    id: 'ceviche-1', nombre: 'Ceviche', precio: 22, categoria: 'plato', disponible: true,
    ingredientes: ['pescado', 'cebolla', 'sal'], alergenos: ['pescado'], informacion_completa: true,
    modificadores_disponibles: [
        { id: 'sin_cebolla', nombre: 'Sin cebolla', tipo: 'remove', ingrediente: 'cebolla' },
        { id: 'poco_sal', nombre: 'Poca sal', tipo: 'level', ingrediente: 'sal', valor: 'low' },
    ],
}];

function classify(text, draftItems = []) {
    return classifyIntent({ text, menu: MENU, draftItems, state: 'awaiting_confirmation', lastProduct: draftItems.at(-1)?.nombre || null });
}

test('clasifica modificadores sin delegarlos al LLM', () => {
    const result = classify('Dame un ceviche sin cebolla');
    assert.equal(result.intent, Intent.ADD_ITEM_MODIFIER);
    assert.equal(result.entities.modifier.ingrediente, 'cebolla');
    assert.equal(result.mutates_order, true);
});

test('clasifica quitar una modificación sin quitar el producto', () => {
    const result = classify('Quita cebolla del ceviche', [{ nombre: 'Ceviche', cantidad: 1 }]);
    assert.equal(result.intent, Intent.REMOVE_ITEM_MODIFIER);
    assert.equal(result.entities.target.nombre, 'Ceviche');
});

test('distingue alergia declarada de preferencia', () => {
    assert.equal(classify('Soy alérgico al pescado').intent, Intent.DECLARE_ALLERGY);
    const risky = classify('Soy alérgico al pescado, pero quiero ceviche');
    assert.equal(risky.intent, Intent.DECLARE_ALLERGY);
    assert.equal(risky.entities.requested_products[0].nombre, 'Ceviche');
    assert.equal(risky.mutates_order, true);
    assert.equal(classify('No soy alérgico, solo no me gusta la cebolla', [{ nombre: 'Ceviche', cantidad: 1 }]).intent, Intent.ADD_ITEM_NOTE);
});

test('consultar ingredientes o maní no muta', () => {
    assert.equal(classify('¿Qué contiene el ceviche?').intent, Intent.QUERY_INGREDIENTS);
    const allergen = classify('¿Tiene maní?');
    assert.equal(allergen.intent, Intent.QUERY_ALLERGENS);
    assert.equal(allergen.mutates_order, false);
});

test('confirmación especial es una intención distinta', () => {
    const result = classify('Confírmalo de todas formas', [{ nombre: 'Ceviche', cantidad: 1 }]);
    assert.equal(result.intent, Intent.CONFIRM_ALLERGY_ORDER);
});

test('clasifica variantes por unidad y cancelación de la última modificación', () => {
    const two = classify('Uno normal y el otro con poca sal', [{ nombre: 'Ceviche', cantidad: 2 }]);
    assert.equal(two.intent, Intent.ADD_ITEM_MODIFIER);
    assert.equal(two.entities.quantity, 2);
    assert.equal(two.entities.scope, 'one');

    const cancelled = classify('No, cancela lo de sin cebolla', [{ nombre: 'Ceviche', cantidad: 1 }]);
    assert.equal(cancelled.intent, Intent.REMOVE_ITEM_MODIFIER);

    const normal = classify('Sí, pero uno normal', [{ nombre: 'Ceviche', cantidad: 2, modificaciones: [{ id: 'sin_cebolla' }] }]);
    assert.equal(normal.intent, Intent.REMOVE_ITEM_MODIFIER);
    assert.equal(normal.entities.scope, 'one');
});

test('las preguntas de seguridad son de solo lectura y copiar requiere contexto', () => {
    const safe = classify('¿Es totalmente seguro?', [{ nombre: 'Ceviche', cantidad: 1 }]);
    assert.equal(safe.intent, Intent.QUERY_ALLERGENS);
    assert.equal(safe.mutates_order, false);

    const copy = classify('Pon lo mismo al segundo', [
        { nombre: 'Ceviche', cantidad: 1, modificaciones: [{ id: 'poco_sal' }] },
        { nombre: 'Lomo saltado', cantidad: 1 },
    ]);
    assert.equal(copy.intent, Intent.REPLACE_ITEM_MODIFIER);
    assert.equal(copy.entities.target.ordinal, 'second');

    const ambiguous = classify('Pon lo mismo al segundo', [
        { nombre: 'Ceviche', cantidad: 1, modificaciones: [{ id: 'poco_sal' }] },
        { nombre: 'Lomo saltado', cantidad: 1 },
        { nombre: 'Tallarines verdes', cantidad: 1 },
    ]);
    assert.equal(ambiguous.requires_clarification, true);
});

test('cubre variantes explícitas, sustitución y consultas de compatibilidad', () => {
    const normalPair = classify('Mejor los dos normales', [
        { nombre: 'Ceviche', cantidad: 1, modificaciones: [{ id: 'sin_cebolla' }] },
        { nombre: 'Ceviche', cantidad: 1, modificaciones: [{ id: 'poco_sal' }] },
    ]);
    assert.equal(normalPair.intent, Intent.REMOVE_ITEM_MODIFIER);
    assert.equal(normalPair.entities.target.all, true);

    const replacement = classify('Cambia poco picante por sin picante', [
        { nombre: 'Ceviche', cantidad: 1, modificaciones: [{ id: 'poco_picante', nombre: 'Poco picante', ingrediente: 'picante' }] },
    ]);
    assert.equal(replacement.intent, Intent.REPLACE_ITEM_MODIFIER);
    assert.equal(replacement.entities.from_modifier.ingrediente, 'picante');

    const splitPlan = classify('El primero normal y el segundo con poca sal', [
        { nombre: 'Ceviche', cantidad: 1 },
        { nombre: 'Ceviche', cantidad: 1 },
    ]);
    assert.equal(splitPlan.intent, Intent.REPLACE_ITEM_MODIFIER);
    assert.equal(splitPlan.entities.variant_plan, 'first_normal_second_modifier');
    assert.equal(splitPlan.entities.target.ordinal, 'second');

    assert.equal(classify('Quiero el ceviche sin arroz').intent, Intent.ADD_ITEM_MODIFIER);
    assert.equal(classify('No puedo consumir leche').intent, Intent.DECLARE_ALLERGY);
    assert.equal(classify('¿Tienen algo vegetariano?').intent, Intent.QUERY_DIETARY_OPTIONS);
    assert.equal(classify('¿Qué bebidas no tienen azúcar?').intent, Intent.QUERY_INGREDIENTS);
    assert.equal(classify('¿Qué recomiendas para un alérgico al maní?').entities.safe_for_allergen, true);
});
