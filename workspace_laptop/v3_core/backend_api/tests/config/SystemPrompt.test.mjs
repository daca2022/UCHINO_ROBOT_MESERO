import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_HRI_CONTEXT_RULES,
    HRI_CONTEXT_KEYS,
    detectHriContext,
    normalizeContextRules,
} from '../../../shared/hriContextRules.mjs';
import { buildSystemPrompt } from '../../src/config/systemPrompt.mjs';

test('HRI context rules: define los 14 contextos del plan', () => {
    assert.equal(HRI_CONTEXT_KEYS.length, 14);
    assert.deepEqual(Object.keys(DEFAULT_HRI_CONTEXT_RULES), HRI_CONTEXT_KEYS);
});

test('HRI context rules: completa defaults sin borrar reglas editadas por Admin', () => {
    const reglas = normalizeContextRules({
        manejo_queja: 'Disculparse y escalar de inmediato.',
    });

    assert.equal(reglas.manejo_queja, 'Disculparse y escalar de inmediato.');
    assert.ok(reglas.reposo_base.includes('wake word'));
    assert.equal(Object.keys(reglas).length, 14);
});

test('HRI context rules: detecta contexto por estado o texto', () => {
    assert.equal(detectHriContext({ state: 'confirming_order' }), 'confirmacion_final');
    assert.equal(detectHriContext({ text: 'quiero la cuenta por favor' }), 'solicitud_cuenta');
    assert.equal(detectHriContext({ text: 'mi pedido llego frio y mal' }), 'manejo_queja');
});

test('buildSystemPrompt: incluye catalogo HRI y contexto activo', () => {
    const prompt = buildSystemPrompt(
        {
            tono: 'serio',
            reglas_contexto: {
                solicitud_cuenta: 'Derivar pago al personal de caja.',
            },
        },
        { text: 'me trae la cuenta' },
    );

    assert.match(prompt, /Reglas HRI por contexto/);
    assert.match(prompt, /solicitud_cuenta/);
    assert.match(prompt, /Derivar pago al personal de caja/);
    assert.match(prompt, /Contexto operativo activo/);
});
