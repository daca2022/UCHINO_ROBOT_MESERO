import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MockLlmProvider } from '../src/adapters/MockLlmProvider.mjs';
import { ILlmProvider } from '../src/ports/ILlmProvider.mjs';

describe('MockLlmProvider — Contrato ILlmProvider', () => {
    it('debe implementar la interfaz ILlmProvider', () => {
        const mock = new MockLlmProvider();
        // Verificar que hereda de ILlmProvider
        assert.ok(mock instanceof ILlmProvider);
    });

    it('debe iniciar y cerrar sesión', async () => {
        const mock = new MockLlmProvider();
        await mock.initSession();
        assert.strictEqual(mock.sessionActive, true);

        await mock.closeSession();
        assert.strictEqual(mock.sessionActive, false);
    });

    it('debe fallar al enviar audio sin sesión iniciada', async () => {
        const mock = new MockLlmProvider();
        await assert.rejects(
            mock.sendAudio(Buffer.from('test')),
            /sesión no iniciada/
        );
    });

    it('debe devolver respuesta mock al enviar audio', async () => {
        const mock = new MockLlmProvider();
        await mock.initSession();
        const res = await mock.sendAudio(Buffer.from('audio-pcm'), 24000);
        assert.ok(Buffer.isBuffer(res.audio));
        assert.strictEqual(res.text, 'Entendido, ¿qué deseas ordenar?');
        assert.deepStrictEqual(res.functionCalls, []);
    });

    it('debe devolver respuesta mock al enviar texto', async () => {
        const mock = new MockLlmProvider();
        await mock.initSession();
        const res = await mock.sendText('Hola');
        assert.strictEqual(res.text, 'Claro, aquí tienes el menú.');
    });

    it('debe devolver respuesta mock al enviar imagen', async () => {
        const mock = new MockLlmProvider();
        await mock.initSession();
        const res = await mock.sendImage(Buffer.from('img'), '¿Qué ves?');
        assert.strictEqual(res.text, 'Veo la imagen. Parece una mesa ocupada.');
    });

    it('debe registrar llamadas en callLog', async () => {
        const mock = new MockLlmProvider();
        await mock.initSession();
        await mock.sendText('test');
        await mock.closeSession();

        assert.strictEqual(mock.callLog.length, 3);
        assert.strictEqual(mock.callLog[0].method, 'initSession');
        assert.strictEqual(mock.callLog[1].method, 'sendText');
        assert.strictEqual(mock.callLog[2].method, 'closeSession');
    });

    it('debe devolver info del modelo', () => {
        const mock = new MockLlmProvider();
        const info = mock.getModelInfo();
        assert.strictEqual(info.name, 'mock-llm');
        assert.deepStrictEqual(info.modality, ['text']);
    });
});
