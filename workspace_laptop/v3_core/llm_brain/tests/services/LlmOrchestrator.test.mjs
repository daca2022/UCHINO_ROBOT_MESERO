/**
 * Tests para LlmOrchestrator y FallbackManager usando MockLlmProvider.
 * Valida: selección de proveedor activo, fallback, circuit breaker, history.
 * Usa node:test nativo de Node.js >= 20.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { LlmOrchestrator } from '../../src/services/LlmOrchestrator.mjs';
import { FallbackManager } from '../../src/services/FallbackManager.mjs';
import { MockLlmProvider } from '../../src/adapters/MockLlmProvider.mjs';

const activeFms = [];
const activeLlms = [];

after(() => {
    for (const fm of activeFms) fm.stopHealthChecks?.();
    for (const llm of activeLlms) llm.shutdown?.();
});

function makeMockProvider(name, behavior = {}) {
    const p = new MockLlmProvider();
    p._name = name;
    p.getModelInfo = () => ({ name, version: '1.0', modality: ['text'] });
    if (behavior.failSendText) {
        p.sendText = async () => { throw new Error(`${name} simulated failure`); };
    }
    if (behavior.textResponse) {
        p.sendText = async (text) => ({ text: behavior.textResponse, functionCalls: [] });
    }
    return p;
}

test('FallbackManager: usa el proveedor activo por defecto', () => {
    const p1 = makeMockProvider('p1', { textResponse: 'hello' });
    const p2 = makeMockProvider('p2', { textResponse: 'hi' });
    const fm = new FallbackManager({
        providers: [
            { name: 'p1', instance: p1, priority: 1 },
            { name: 'p2', instance: p2, priority: 2 },
        ],
    });
    activeFms.push(fm);
    assert.equal(fm.getActiveProvider().name, 'p1');
});

test('FallbackManager: rota a fallback cuando el primario falla', async () => {
    const p1 = makeMockProvider('p1', { failSendText: true });
    const p2 = makeMockProvider('p2', { textResponse: 'fallback-ok' });
    const fm = new FallbackManager({
        providers: [
            { name: 'p1', instance: p1, priority: 1 },
            { name: 'p2', instance: p2, priority: 2 },
        ],
        circuitBreaker: { failureThreshold: 1, resetTimeout: 60000 },
        retry: { maxRetries: 0, baseDelay: 1 },
        healthCheckInterval: 0, // desactiva health checks automáticos
    });
    const result = await fm.executeWithFallback(async (provider) => provider.sendText('hola'));
    assert.equal(result.text, 'fallback-ok');
    assert.equal(fm.getActiveProvider().name, 'p2');
    fm.stopHealthChecks?.();
});

test('LlmOrchestrator: init() carga system prompt y abre sesión', async () => {
    const p = makeMockProvider('mock', { textResponse: 'ok' });
    const llm = new LlmOrchestrator(p, { logger: { log: () => {} } });
    activeLlms.push(llm);
    await llm.init('Eres Uchino, robot mesero.');
    assert.equal(llm._systemPrompt, 'Eres Uchino, robot mesero.');
});

test('LlmOrchestrator: processText delega al proveedor activo y registra historial', async () => {
    const p = makeMockProvider('mock', { textResponse: 'pong' });
    const llm = new LlmOrchestrator(p, { logger: { log: () => {}, warn: () => {} } });
    activeLlms.push(llm);
    await llm.init('test prompt');
    const result = await llm.processText('ping');
    assert.equal(result.text, 'pong');
    assert.ok(llm.history.length >= 1, 'debe registrar el turno en history');
});

test('LlmOrchestrator: getActiveProvider() expone el provider actual', async () => {
    const p = makeMockProvider('deepseek-v4-flash');
    const llm = new LlmOrchestrator(p, { logger: { log: () => {} } });
    activeLlms.push(llm);
    await llm.init('test');
    const active = llm.getActiveProvider();
    assert.equal(active.name, 'deepseek-v4-flash');
});

test('LlmOrchestrator: switchProvider() cambia a un proveedor configurado por nombre', async () => {
    const p1 = makeMockProvider('primary-model', { textResponse: 'primary' });
    const p2 = makeMockProvider('fallback-model', { textResponse: 'fallback' });
    const fm = new FallbackManager({
        providers: [
            { name: 'primary-model', instance: p1, priority: 1 },
            { name: 'fallback-model', instance: p2, priority: 2 },
        ],
        healthCheckInterval: 0,
    });
    const llm = new LlmOrchestrator(p1, {
        fallbackProvider: p2,
        logger: { log: () => {}, warn: () => {} },
    });
    llm._providers = [
        { name: 'primary-model', instance: p1, priority: 1 },
        { name: 'fallback-model', instance: p2, priority: 2 },
    ];
    llm._fallbackManager = fm;
    activeLlms.push(llm);
    activeFms.push(fm);
    await llm.init('test prompt');

    const result = await llm.switchProvider('fallback-model');
    const response = await llm.processText('hola');

    assert.equal(result.name, 'fallback-model');
    assert.equal(llm.getActiveProvider().name, 'fallback-model');
    assert.equal(llm.active.getModelInfo().name, 'fallback-model');
    assert.equal(response.text, 'fallback');
});

test('LlmOrchestrator: switchProvider() rechaza proveedores no configurados', async () => {
    const p = makeMockProvider('primary-model');
    const llm = new LlmOrchestrator(p, { logger: { log: () => {} } });
    llm._providers = [{ name: 'primary-model', instance: p, priority: 1 }];
    activeLlms.push(llm);
    await llm.init('test prompt');

    await assert.rejects(() => llm.switchProvider('unknown-model'), /proveedor LLM desconocido/i);
});

test('LlmOrchestrator: processText retorna actions cuando hay function calls', async () => {
    const p = makeMockProvider('mock', { textResponse: 'ok' });
    p.sendText = async () => ({
        text: 'registrando pedido',
        functionCalls: [{ name: 'registrar_pedido', args: { mesa: 'M1', platos: [] } }],
    });
    const llm = new LlmOrchestrator(p, {
        logger: { log: () => {}, warn: () => {} },
        functionHandlers: {
            registrar_pedido: () => ({ ok: true }),
        },
    });
    activeLlms.push(llm);
    await llm.init('test');
    const r = await llm.processText('quiero un cafe');
    assert.equal(r.text, 'registrando pedido');
    assert.ok(Array.isArray(r.actions));
    assert.equal(r.actions.length, 1);
    assert.equal(r.actions[0].name, 'registrar_pedido');
    assert.deepEqual(r.actions[0].result, { ok: true });
});
