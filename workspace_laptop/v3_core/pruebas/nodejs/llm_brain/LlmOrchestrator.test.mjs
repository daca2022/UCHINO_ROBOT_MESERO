import { describe, it } from 'node:test';
import assert from 'node:assert';
import { LlmOrchestrator } from '../src/services/LlmOrchestrator.mjs';
import { MockLlmProvider } from '../src/adapters/MockLlmProvider.mjs';

describe('LlmOrchestrator — Ciclo completo', () => {
    it('debe procesar texto y ejecutar function calls', async () => {
        const mock = new MockLlmProvider({
            textResponse: {
                audio: null,
                text: 'Pedido registrado',
                functionCalls: [
                    { name: 'registrar_pedido', args: { mesa: 'M1', platos: [{ nombre: 'Lomo', cantidad: 1 }] } }
                ],
            },
        });

        let pedidoGuardado = null;
        const orchestrator = new LlmOrchestrator(mock, {
            functionHandlers: {
                registrar_pedido: (args) => {
                    pedidoGuardado = args;
                    return { ok: true, id: 'p-123' };
                },
            },
        });

        await orchestrator.init('Eres un robot mesero');
        const res = await orchestrator.processText('Quiero un lomo');

        assert.strictEqual(res.text, 'Pedido registrado');
        assert.strictEqual(pedidoGuardado.mesa, 'M1');
        assert.strictEqual(res.actions[0].result.ok, true);
        assert.strictEqual(orchestrator.history.length, 2); // user + model
    });

    it('debe manejar function call sin handler registrado', async () => {
        const mock = new MockLlmProvider({
            textResponse: {
                audio: null,
                text: 'Ok',
                functionCalls: [{ name: 'funcion_desconocida', args: {} }],
            },
        });

        const orchestrator = new LlmOrchestrator(mock, { functionHandlers: {} });
        await orchestrator.init();
        const res = await orchestrator.processText('test');

        assert.strictEqual(res.actions[0].result.error, 'Función no implementada: funcion_desconocida');
    });

    it('debe disparar callback de emoción', async () => {
        const mock = new MockLlmProvider({
            textResponse: {
                audio: null,
                text: '¡Qué alegría!',
                functionCalls: [{ name: 'expresar_emocion', args: { emocion: 'feliz', mensaje: 'Hola!' } }],
            },
        });

        let emotionFired = null;
        const orchestrator = new LlmOrchestrator(mock, {
            onEmotion: (emo, msg) => { emotionFired = { emo, msg }; },
        });

        await orchestrator.init();
        await orchestrator.processText('Hola');

        assert.strictEqual(emotionFired.emo, 'feliz');
        assert.strictEqual(emotionFired.msg, 'Hola!');
    });

    it('debe limitar historial a 20 mensajes', async () => {
        const mock = new MockLlmProvider();
        const orchestrator = new LlmOrchestrator(mock);
        await orchestrator.init();

        for (let i = 0; i < 25; i++) {
            orchestrator._appendHistory('user', `msg-${i}`);
        }

        assert.strictEqual(orchestrator.history.length, 20);
        assert.strictEqual(orchestrator.history[0].content, 'msg-5'); // Se recortaron los primeros 5 (0-4)
    });
});

describe('LlmOrchestrator — 3-provider fallback', () => {
    it('fromDefaults debe crear orchestrator con FallbackManager y 3 providers', async () => {
        const orchestrator = await LlmOrchestrator.fromDefaults();
        assert.ok(orchestrator._fallbackManager, 'debe tener _fallbackManager');
        assert.ok(orchestrator._providers, 'debe tener _providers');
        assert.strictEqual(orchestrator._providers.length, 3);
        orchestrator._fallbackManager.stopHealthChecks();
        await orchestrator.shutdown();
    });

    it('debe usar FallbackManager y cambiar al secundario cuando el primario falla', async () => {
        const primary = new MockLlmProvider({ textResponse: { audio: null, text: 'primary', functionCalls: [] } });
        const secondary = new MockLlmProvider({ textResponse: { audio: null, text: 'secondary', functionCalls: [] } });
        const tertiary = new MockLlmProvider({ textResponse: { audio: null, text: 'tertiary', functionCalls: [] } });

        await primary.initSession();
        await secondary.initSession();
        await tertiary.initSession();

        primary.sendText = async () => { throw new Error('primary down'); };

        const orchestrator = new LlmOrchestrator(primary, { fallbackProvider: secondary });
        const { FallbackManager } = await import('../src/services/FallbackManager.mjs');
        const fallbackManager = new FallbackManager({
            providers: [
                { name: 'primary', instance: primary, priority: 1 },
                { name: 'secondary', instance: secondary, priority: 2 },
                { name: 'tertiary', instance: tertiary, priority: 3 },
            ],
            circuitBreaker: { failureThreshold: 1, resetTimeout: 30000 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 0,
        });
        orchestrator._fallbackManager = fallbackManager;
        orchestrator._providers = fallbackManager._providers;

        await orchestrator.init('test');
        const res = await orchestrator.processText('hola');

        assert.strictEqual(res.text, 'secondary');
        assert.strictEqual(orchestrator.active, secondary);
        fallbackManager.stopHealthChecks();
    });

    it('debe caer al tercer proveedor si primario y secundario fallan', async () => {
        const primary = new MockLlmProvider();
        const secondary = new MockLlmProvider();
        const tertiary = new MockLlmProvider({ textResponse: { audio: null, text: 'tertiary ok', functionCalls: [] } });

        await primary.initSession();
        await secondary.initSession();
        await tertiary.initSession();

        primary.sendText = async () => { throw new Error('primary down'); };
        secondary.sendText = async () => { throw new Error('secondary down'); };

        const orchestrator = new LlmOrchestrator(primary, { fallbackProvider: secondary });
        const { FallbackManager } = await import('../src/services/FallbackManager.mjs');
        const fallbackManager = new FallbackManager({
            providers: [
                { name: 'primary', instance: primary, priority: 1 },
                { name: 'secondary', instance: secondary, priority: 2 },
                { name: 'tertiary', instance: tertiary, priority: 3 },
            ],
            circuitBreaker: { failureThreshold: 1, resetTimeout: 30000 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 0,
        });
        orchestrator._fallbackManager = fallbackManager;
        orchestrator._providers = fallbackManager._providers;

        await orchestrator.init('test');
        const res = await orchestrator.processText('hola');

        assert.strictEqual(res.text, 'tertiary ok');
        assert.strictEqual(orchestrator.active, tertiary);
        fallbackManager.stopHealthChecks();
    });

    it('debe exponer getActiveProvider y getProviderStatus con FallbackManager', async () => {
        const primary = new MockLlmProvider();
        const secondary = new MockLlmProvider();

        await primary.initSession();
        await secondary.initSession();

        const orchestrator = new LlmOrchestrator(primary, { fallbackProvider: secondary });
        const { FallbackManager } = await import('../src/services/FallbackManager.mjs');
        const fallbackManager = new FallbackManager({
            providers: [
                { name: 'p1', instance: primary, priority: 1 },
                { name: 'p2', instance: secondary, priority: 2 },
            ],
            circuitBreaker: { failureThreshold: 1, resetTimeout: 30000 },
            retry: { maxRetries: 0, baseDelay: 10 },
            healthCheckInterval: 0,
        });
        orchestrator._fallbackManager = fallbackManager;
        orchestrator._providers = fallbackManager._providers;

        await orchestrator.init('test');

        const active = orchestrator.getActiveProvider();
        assert.strictEqual(active.name, 'p1');

        const status = orchestrator.getProviderStatus();
        assert.strictEqual(status.length, 2);
        assert.strictEqual(status[0].name, 'p1');
        assert.strictEqual(status[1].name, 'p2');

        fallbackManager.stopHealthChecks();
    });

    it('getActiveProvider y getProviderStatus deben funcionar sin FallbackManager (backward compat)', async () => {
        const mock = new MockLlmProvider();
        const orchestrator = new LlmOrchestrator(mock);
        await orchestrator.init();

        const active = orchestrator.getActiveProvider();
        assert.strictEqual(active.name, 'mock-llm');

        const status = orchestrator.getProviderStatus();
        assert.strictEqual(status.length, 1);
        assert.strictEqual(status[0].name, 'mock-llm');
        assert.strictEqual(status[0].status, 'unknown');
    });
});
