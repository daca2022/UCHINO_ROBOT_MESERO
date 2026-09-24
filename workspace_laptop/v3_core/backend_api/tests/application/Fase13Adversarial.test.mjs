import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyIntent, Intent } from '../../src/application/IntentClassifier.mjs';

const catalogUrl = new URL('../../../../../.sisyphus/evidence/fase13/adversarial_cases.json', import.meta.url);
const catalog = JSON.parse(fs.readFileSync(catalogUrl, 'utf8'));

const MENU = [
    { id: 'p1', product_id: 'p1', nombre: 'Ceviche', categoria: 'platos', precio: 25, disponible: true, ingredientes: ['pescado'], alergenos: ['pescado'], modificadores_disponibles: [] },
    { id: 'p2', product_id: 'p2', nombre: 'Lomo Saltado', categoria: 'platos', precio: 28, disponible: true, ingredientes: ['carne'], alergenos: [], modificadores_disponibles: [] },
    { id: 'p3', product_id: 'p3', nombre: 'Tallarines Verdes', categoria: 'platos', precio: 22, disponible: true, ingredientes: [], alergenos: [], modificadores_disponibles: [] },
    { id: 'p4', product_id: 'p4', nombre: 'Chicha Morada', categoria: 'bebidas', precio: 8, disponible: true, ingredientes: [], alergenos: [], modificadores_disponibles: [] },
    { id: 'p5', product_id: 'p5', nombre: 'Suspiro a la Limeña', categoria: 'postres', precio: 10, disponible: true, ingredientes: [], alergenos: [], modificadores_disponibles: [] },
];

const DRAFT = [
    { ...MENU[0], cantidad: 1 },
    { ...MENU[2], cantidad: 1 },
    { ...MENU[4], cantidad: 1 },
];

function classify(text, { state = 'awaiting_confirmation', draftItems = DRAFT, lastProduct = 'Tallarines Verdes' } = {}) {
    return classifyIntent({
        text,
        menu: MENU,
        draftItems,
        state,
        interactionMode: 'voice',
        lastProduct,
    });
}

test('Fase 13: el catálogo adversarial tiene ground truth completo y fixtures aislados', () => {
    assert.ok(catalog.length >= 150);
    assert.equal(new Set(catalog.map(item => item.case_id)).size, catalog.length);
    const required = [
        'case_id', 'initial_state', 'initial_cart', 'mesa', 'session_id', 'phrase',
        'expected_intent', 'mutates_order', 'expected_result', 'expected_response',
        'final_state', 'forbidden_effects',
    ];
    for (const item of catalog) {
        for (const key of required) assert.ok(Object.hasOwn(item, key), `${item.case_id} missing ${key}`);
        assert.match(item.session_id, /^qa-f13-/u);
        assert.match(item.mesa, /^M(?:[1-9]|1[0-2])$/u);
        assert.ok(Array.isArray(item.forbidden_effects));
    }
});

test('Fase 13: confirmaciones naturales exigidas mutan solo al confirmar', () => {
    const phrases = [
        'Confirmo', 'Confirma mi pedido', 'Sí, confirma', 'Correcto', 'Dale',
        'Está bien', 'Ya está', 'Eso sería todo', 'Nada más', 'Mándalo a cocina',
        'Terminé', 'Sí, eso quiero', 'Procede',
    ];
    for (const phrase of phrases) {
        const result = classify(phrase);
        assert.equal(result.intent, Intent.CONFIRM_ORDER, phrase);
        assert.equal(result.mutates_order, true, phrase);
    }
});

test('Fase 13: negaciones y frases mixtas tienen prioridad sobre confirmar', () => {
    for (const phrase of [
        'No confirmes', 'Todavía no', 'Espera', 'Aún falta', 'No lo envíes',
        'No está bien', 'Eso no es todo', 'Eso es todo, pero todavía no lo envíes',
    ]) {
        const result = classify(phrase);
        assert.equal(result.intent, Intent.REJECT_CONFIRMATION, phrase);
        assert.equal(result.mutates_order, false, phrase);
    }

    const replacement = classify('Dale... no, mejor cambia el ceviche por lomo saltado');
    assert.equal(replacement.intent, Intent.REPLACE_PRODUCT);
    assert.equal(replacement.mutates_order, true);

    const removal = classify('Sí, pero antes quita el postre');
    assert.equal(removal.intent, Intent.REMOVE_PRODUCT);
    assert.equal(removal.mutates_order, true);
    assert.equal(removal.entities.confirm_after_edit, true);
});

test('Fase 13: repetición no duplica, incremento y cantidad total sí se distinguen', () => {
    const repeat = classify('Dame un tallarín, pero ya lo anotaste');
    assert.equal(repeat.intent, Intent.REPEAT_PRODUCT);
    assert.equal(repeat.mutates_order, false);

    const increment = classify('Agrega otro tallarín');
    assert.equal(increment.intent, Intent.INCREMENT_QUANTITY);
    assert.equal(increment.entities.quantity_mode, 'increment');

    const total = classify('Quiero dos tallarines');
    assert.equal(total.intent, Intent.CHANGE_QUANTITY);
    assert.equal(total.entities.quantity_mode, 'total');
    assert.equal(total.entities.quantity, 2);

    const consultation = classify('Repíteme mi pedido');
    assert.equal(consultation.intent, Intent.CONSULT_ORDER);
    assert.equal(consultation.mutates_order, false);
});

test('Fase 13: ambigüedad y preferencias no modifican el pedido', () => {
    for (const [phrase, options] of [
        ['Quita uno', { lastProduct: null }],
        ['Agrega esa', { lastProduct: null }],
        ['Sin eso', { lastProduct: null }],
        ['No soy alérgico, solo no me gusta', { lastProduct: null }],
        ['Recuerda que no me gusta el picante', { lastProduct: null }],
    ]) {
        const result = classify(phrase, options);
        assert.equal(result.mutates_order, false, phrase);
        assert.equal(result.requires_clarification || result.intent === Intent.SOCIAL_CONVERSATION, true, phrase);
    }
});

test('Fase 13: reemplazo explícito conserva una sola intención de producto', () => {
    const result = classify('Cambia el ceviche por lomo saltado');
    assert.equal(result.intent, Intent.REPLACE_PRODUCT);
    assert.equal(result.entities.source_product.nombre, 'Ceviche');
    assert.equal(result.entities.target_product.nombre, 'Lomo Saltado');
});
