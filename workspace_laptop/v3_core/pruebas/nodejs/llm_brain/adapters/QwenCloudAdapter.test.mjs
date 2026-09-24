/**
 * QwenCloudAdapter tests — TDD (RED → GREEN)
 * Tests for OpenAI-compatible adapter supporting DashScope and OpenRouter.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { createMockFetch } from '../helpers/mockFetch.mjs';
import { FUNCTION_CALL_REGISTRAR_PEDIDO, ERROR_TIMEOUT, ERROR_AUTH } from '../helpers/fixtures.mjs';

// The implementation file does NOT exist yet — these tests will FAIL (RED phase)
import { QwenCloudAdapter } from '../../src/adapters/QwenCloudAdapter.mjs';

const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'qwen3.5-flash';
const DEFAULT_TIMEOUT = 30000;

// ── Constructor ─────────────────────────────────────────

describe('QwenCloudAdapter — Constructor', () => {
    test('sets default config (baseUrl, model, timeout)', () => {
        const adapter = new QwenCloudAdapter({ apiKey: 'test-key' });
        expect(adapter.baseUrl).toBe(DASHSCOPE_BASE_URL);
        expect(adapter.modelName).toBe(DEFAULT_MODEL);
        expect(adapter.requestTimeout).toBe(DEFAULT_TIMEOUT);
        expect(adapter.apiKey).toBe('test-key');
    });

    test('accepts custom config', () => {
        const adapter = new QwenCloudAdapter({
            baseUrl: OPENROUTER_BASE_URL,
            apiKey: 'or-key',
            model: 'custom-model',
            systemPrompt: 'Custom prompt',
            tools: [{ functionDeclarations: [] }],
            timeout: 15000,
        });
        expect(adapter.baseUrl).toBe(OPENROUTER_BASE_URL);
        expect(adapter.modelName).toBe('custom-model');
        expect(adapter.apiKey).toBe('or-key');
        expect(adapter.systemPrompt).toBe('Custom prompt');
        expect(adapter.requestTimeout).toBe(15000);
        expect(adapter.tools).toEqual([{ functionDeclarations: [] }]);
    });
});

// ── Session lifecycle ─────────────────────────────────────

describe('QwenCloudAdapter — Session lifecycle', () => {
    test('initSession() stores system prompt in messages', async () => {
        const adapter = new QwenCloudAdapter({ apiKey: 'test' });
        await adapter.initSession('Eres un mesero robot');
        expect(adapter.messages.length).toBe(1);
        expect(adapter.messages[0].role).toBe('system');
        expect(adapter.messages[0].content).toBe('Eres un mesero robot');
        expect(adapter.sessionActive).toBe(true);
    });

    test('closeSession() clears messages and session flag', async () => {
        const adapter = new QwenCloudAdapter({ apiKey: 'test' });
        await adapter.initSession('Prompt');
        await adapter.closeSession();
        expect(adapter.messages.length).toBe(0);
        expect(adapter.sessionActive).toBe(false);
    });
});

// ── sendText() ──────────────────────────────────────────

describe('QwenCloudAdapter — sendText()', () => {
    const mf = createMockFetch();

    beforeAll(() => mf.install());
    afterEach(() => mf.reset());
    afterAll(() => mf.uninstall());

    test('calls fetch with correct URL, headers and body', async () => {
        mf.mock(/\/chat\/completions$/, {
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'Hola cliente' } }],
            }),
        });

        const adapter = new QwenCloudAdapter({
            baseUrl: DASHSCOPE_BASE_URL,
            apiKey: 'ds-key',
            model: 'qwen3.5-flash',
        });
        await adapter.initSession('Eres Uchino');
        await adapter.sendText('Quiero un café');

        const calls = mf.calls();
        expect(calls.length).toBe(1);
        expect(calls[0].url).toBe(`${DASHSCOPE_BASE_URL}/chat/completions`);
        expect(calls[0].method).toBe('POST');

        const headers = calls[0].headers;
        expect(headers['Authorization']).toBe('Bearer ds-key');
        expect(headers['Content-Type']).toBe('application/json');

        const body = JSON.parse(calls[0].body);
        expect(body.model).toBe('qwen3.5-flash');
        expect(body.stream).toBe(false);
        expect(body.temperature).toBe(0.3);
        expect(body.messages).toEqual([
            { role: 'system', content: 'Eres Uchino' },
            { role: 'user', content: 'Quiero un café' },
        ]);
    });

    test('parses OpenAI response into {text, functionCalls}', async () => {
        mf.mock(/\/chat\/completions$/, {
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: '¡Claro pe! Un cafecito al toque.' } }],
            }),
        });

        const adapter = new QwenCloudAdapter({ apiKey: 'test' });
        await adapter.initSession();
        const res = await adapter.sendText('Un café por favor');

        expect(res.text).toBe('¡Claro pe! Un cafecito al toque.');
        expect(Array.isArray(res.functionCalls)).toBe(true);
        expect(res.functionCalls.length).toBe(0);
    });

    test('handles tool_calls in response', async () => {
        mf.mock(/\/chat\/completions$/, {
            status: 200,
            body: JSON.stringify({
                choices: [{
                    message: {
                        content: 'Registrando su pedido...',
                        tool_calls: [{
                            function: {
                                name: 'registrar_pedido',
                                arguments: JSON.stringify({
                                    mesa: 'M3',
                                    platos: [{ nombre: 'Lomo Saltado', cantidad: 1 }],
                                }),
                            },
                        }],
                    },
                }],
            }),
        });

        const adapter = new QwenCloudAdapter({ apiKey: 'test' });
        await adapter.initSession();
        const res = await adapter.sendText('Quiero un lomo saltado');

        expect(res.text).toBe('Registrando su pedido...');
        expect(res.functionCalls.length).toBe(1);
        expect(res.functionCalls[0].name).toBe('registrar_pedido');
        expect(res.functionCalls[0].args.mesa).toBe('M3');
        expect(res.functionCalls[0].args.platos[0].nombre).toBe('Lomo Saltado');
    });

    test('retries on timeout (3 retries, 4 attempts total)', async () => {
        let callCount = 0;
        const originalFetch = globalThis.fetch;

        // Override fetch to throw 3 times, then succeed
        globalThis.fetch = async (...args) => {
            callCount++;
            if (callCount <= 3) {
                const err = new Error('Request timeout: LLM no respondió en 30s');
                err.name = 'AbortError';
                throw err;
            }
            return originalFetch(...args);
        };

        mf.mock(/\/chat\/completions$/, {
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'Respuesta tras retry' } }],
            }),
        });

        const adapter = new QwenCloudAdapter({
            apiKey: 'test',
            timeout: 1000,
        });
        // Skip actual sleep to keep test fast
        adapter._sleep = () => Promise.resolve();
        await adapter.initSession();

        const res = await adapter.sendText('Hola');

        expect(callCount).toBe(4);
        expect(res.text).toBe('Respuesta tras retry');

        globalThis.fetch = originalFetch;
    });

    test('throws after all retries exhausted', async () => {
        let callCount = 0;
        const originalFetch = globalThis.fetch;

        globalThis.fetch = async () => {
            callCount++;
            const err = new Error('Network timeout');
            err.name = 'AbortError';
            throw err;
        };

        const adapter = new QwenCloudAdapter({
            apiKey: 'test',
            timeout: 500,
        });
        adapter._sleep = () => Promise.resolve();
        await adapter.initSession();

        await expect(adapter.sendText('Hola')).rejects.toThrow(/QwenCloudAdapter:.*falló después de 4 intentos/);
        expect(callCount).toBe(4);

        globalThis.fetch = originalFetch;
    });

    test('retries on 5xx error', async () => {
        let callCount = 0;
        const originalFetch = globalThis.fetch;

        globalThis.fetch = async (...args) => {
            callCount++;
            if (callCount <= 3) {
                return new Response('Internal Server Error', { status: 502 });
            }
            return originalFetch(...args);
        };

        mf.mock(/\/chat\/completions$/, {
            status: 200,
            body: JSON.stringify({
                choices: [{ message: { content: 'OK después de 502' } }],
            }),
        });

        const adapter = new QwenCloudAdapter({ apiKey: 'test', timeout: 500 });
        adapter._sleep = () => Promise.resolve();
        await adapter.initSession();
        const res = await adapter.sendText('test');

        expect(callCount).toBe(4);
        expect(res.text).toBe('OK después de 502');

        globalThis.fetch = originalFetch;
    });
});

// ── Unsupported methods ─────────────────────────────────

describe('QwenCloudAdapter — Unsupported methods', () => {
    test('sendAudio() throws Error mentioning STT→text pipeline', async () => {
        const adapter = new QwenCloudAdapter({ apiKey: 'test' });
        await adapter.initSession();
        await expect(adapter.sendAudio(Buffer.from('pcm'), 24000)).rejects.toThrow(
            /STT→text/
        );
    });

    test('sendImage() throws Error about this phase', async () => {
        const adapter = new QwenCloudAdapter({ apiKey: 'test' });
        await adapter.initSession();
        await expect(adapter.sendImage(Buffer.from('img'), '¿Qué ves?')).rejects.toThrow(
            /this phase/
        );
    });
});

// ── getModelInfo() ──────────────────────────────────────

describe('QwenCloudAdapter — getModelInfo()', () => {
    test('returns correct name, version and modality', () => {
        const adapter = new QwenCloudAdapter({
            apiKey: 'test',
            model: 'qwen3.5-flash',
        });
        const info = adapter.getModelInfo();
        expect(info.name).toBe('qwen3.5-flash');
        expect(info.version).toBe('cloud-openai-compatible');
        expect(info.modality).toEqual(['text']);
    });
});

// ── Tool conversion ─────────────────────────────────────

describe('QwenCloudAdapter — _convertTools()', () => {
    test('converts Gemini functionDeclarations to OpenAI tools format', () => {
        const adapter = new QwenCloudAdapter({ apiKey: 'test' });
        const geminiTools = [{
            functionDeclarations: [{
                name: 'registrar_pedido',
                description: 'Registra el pedido.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        mesa: { type: 'STRING' },
                        platos: { type: 'ARRAY', items: { type: 'OBJECT', properties: { nombre: { type: 'STRING' } } } },
                    },
                    required: ['mesa'],
                },
            }],
        }];

        const openaiTools = adapter._convertTools(geminiTools);
        expect(openaiTools.length).toBe(1);
        expect(openaiTools[0].type).toBe('function');
        expect(openaiTools[0].function.name).toBe('registrar_pedido');
        expect(openaiTools[0].function.description).toBe('Registra el pedido.');
        expect(openaiTools[0].function.parameters.type).toBe('object');
        expect(openaiTools[0].function.parameters.properties.mesa.type).toBe('string');
        expect(openaiTools[0].function.parameters.properties.platos.type).toBe('array');
        expect(openaiTools[0].function.parameters.required).toEqual(['mesa']);
    });
});
