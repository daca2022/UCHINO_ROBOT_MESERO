import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, InteractionMode, Intent } from '../../src/application/IntentClassifier.mjs';

const MENU = [
    { nombre: 'Ceviche', precio: 22, categoria: 'platos', disponible: true },
    { nombre: 'Lomo saltado', precio: 25, categoria: 'platos', disponible: true },
    { nombre: 'Tallarines verdes', precio: 20, categoria: 'platos', disponible: true },
    { nombre: 'Suspiro a la limeña', precio: 6, categoria: 'postres', disponible: true },
];

const draft = [
    { nombre: 'Ceviche', cantidad: 1 },
    { nombre: 'Suspiro a la limeña', cantidad: 1 },
];

function classify(text, overrides = {}) {
    return classifyIntent({
        text,
        menu: MENU,
        draftItems: [],
        state: 'idle',
        ...overrides,
    });
}

test('clasifica las tres opciones de modo y el cambio de modo', () => {
    assert.deepEqual(classify('Por voz').entities.mode, InteractionMode.VOICE);
    assert.equal(classify('Por voz').intent, Intent.SELECT_INTERACTION_MODE);
    assert.equal(classify('Usar pantalla').entities.mode, InteractionMode.SCREEN);
    assert.equal(classify('Quiero que me atienda un mesero').intent, Intent.REQUEST_HUMAN_WAITER);
    assert.equal(classify('Cambiar modo').intent, Intent.CHANGE_INTERACTION_MODE);
    assert.equal(classify('Cambiar modo').requires_clarification, true);
});

test('reconoce confirmaciones naturales, pero la negación tiene prioridad', () => {
    const positives = [
        'Confirmo mi pedido', 'Ya está', 'Eso sería todo', 'Nada más', 'Envíalo',
        'Puedes mandarlo a cocina', 'Correcto', 'Dale', 'Está bien', 'Terminé',
    ];
    for (const phrase of positives) {
        assert.equal(classify(phrase, { state: 'awaiting_confirmation', draftItems: draft }).intent, Intent.CONFIRM_ORDER, phrase);
    }

    const negatives = [
        'Todavía no confirmes', 'No lo envíes', 'Espera', 'Aún falta algo',
        'No confirmes todavía', 'Eso no está bien',
    ];
    for (const phrase of negatives) {
        const result = classify(phrase, { state: 'awaiting_confirmation', draftItems: draft });
        assert.notEqual(result.intent, Intent.CONFIRM_ORDER, phrase);
        assert.equal(result.mutates_order, false, phrase);
    }
});

test('distingue repetición, incremento explícito y cantidad total', () => {
    const repeat = classify('Solo quiero tallarines', {
        state: 'awaiting_confirmation',
        draftItems: [{ nombre: 'Tallarines verdes', cantidad: 1 }],
        lastProduct: 'Tallarines verdes',
    });
    assert.equal(repeat.intent, Intent.REPEAT_PRODUCT);
    assert.equal(repeat.mutates_order, false);

    const repeatWithAffirmation = classify('Sí, tallarines, eso es lo que quiero', {
        state: 'awaiting_confirmation',
        draftItems: [{ nombre: 'Tallarines verdes', cantidad: 1 }],
    });
    assert.equal(repeatWithAffirmation.intent, Intent.REPEAT_PRODUCT);
    assert.equal(repeatWithAffirmation.mutates_order, false);

    const increment = classify('Agrega otro tallarín');
    assert.equal(increment.intent, Intent.INCREMENT_QUANTITY);
    assert.equal(increment.entities.quantity_mode, 'increment');
    assert.equal(increment.entities.quantity, 1);

    const total = classify('Quiero dos tallarines');
    assert.equal(total.intent, Intent.CHANGE_QUANTITY);
    assert.equal(total.entities.quantity_mode, 'total');
    assert.equal(total.entities.quantity, 2);
});

test('consulta no muta y las eliminaciones ambiguas no mutan', () => {
    const consult = classify('Repíteme mi pedido', { state: 'awaiting_confirmation', draftItems: draft });
    assert.equal(consult.intent, Intent.CONSULT_ORDER);
    assert.equal(consult.mutates_order, false);

    const ambiguous = classify('Quita uno', { draftItems: draft });
    assert.equal(ambiguous.intent, Intent.REQUEST_CLARIFICATION);
    assert.equal(ambiguous.requires_clarification, true);
    assert.equal(ambiguous.mutates_order, false);
});

test('resuelve quitar, reemplazar y la corrección previa a confirmar', () => {
    const remove = classify('Quita el ceviche', { draftItems: draft });
    assert.equal(remove.intent, Intent.REMOVE_PRODUCT);
    assert.equal(remove.entities.products[0].nombre, 'Ceviche');

    const replace = classify('Cambia el ceviche por lomo saltado', { draftItems: draft });
    assert.equal(replace.intent, Intent.REPLACE_PRODUCT);
    assert.equal(replace.entities.source_product.nombre, 'Ceviche');
    assert.equal(replace.entities.target_product.nombre, 'Lomo saltado');

    const beforeConfirm = classify('Sí, pero antes quita el postre', {
        state: 'awaiting_confirmation',
        draftItems: draft,
    });
    assert.equal(beforeConfirm.intent, Intent.REMOVE_PRODUCT);
    assert.equal(beforeConfirm.entities.confirm_after_edit, true);
    assert.equal(beforeConfirm.entities.products[0].nombre, 'Suspiro a la limeña');

    const unclearReplace = classify('Cambia ese por ceviche', { draftItems: draft });
    assert.equal(unclearReplace.intent, Intent.REQUEST_CLARIFICATION);
    assert.equal(unclearReplace.mutates_order, false);
});

test('usa el último producto solo cuando la reducción contextual es inequívoca', () => {
    const setOne = classify('Déjalo en uno', {
        draftItems: [{ nombre: 'Tallarines verdes', cantidad: 2 }],
        lastProduct: 'Tallarines verdes',
    });
    assert.equal(setOne.intent, Intent.CHANGE_QUANTITY);
    assert.equal(setOne.entities.quantity, 1);
    assert.equal(setOne.entities.products[0].nombre, 'Tallarines verdes');

    const unsafeOther = classify('Quita el otro', {
        draftItems: [
            { nombre: 'Ceviche', cantidad: 1 },
            { nombre: 'Suspiro a la limeña', cantidad: 1 },
            { nombre: 'Lomo saltado', cantidad: 1 },
        ],
        lastProduct: 'Ceviche',
    });
    assert.equal(unsafeOther.intent, Intent.REQUEST_CLARIFICATION);
    assert.equal(unsafeOther.mutates_order, false);
});

test('no selecciona una variante arbitraria cuando el nombre del producto es ambiguo', () => {
    const result = classifyIntent({
        text: 'Quiero una empanada',
        menu: [
            ...MENU,
            { nombre: 'Empanada de pollo', precio: 4, categoria: 'comidas', disponible: true },
            { nombre: 'Empanada de queso', precio: 4, categoria: 'comidas', disponible: true },
        ],
    });
    assert.equal(result.intent, Intent.REQUEST_CLARIFICATION);
    assert.equal(result.mutates_order, false);
    assert.deepEqual(result.entities.product_candidates, ['Empanada de pollo', 'Empanada de queso']);
});
