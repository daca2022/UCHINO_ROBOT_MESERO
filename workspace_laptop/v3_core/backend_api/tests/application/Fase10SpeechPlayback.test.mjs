import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SpeechPlaybackService } from '../../src/application/SpeechPlaybackService.mjs';
import { Ros2DeliverySimulator } from '../../src/application/Ros2DeliverySimulator.mjs';

class FakePlayer extends EventEmitter {
    constructor() {
        super();
        this.isReady = true;
        this.isSpeaking = false;
        this.sent = [];
        this.cancelled = 0;
    }

    speak(text, options) {
        this.sent.push({ text, ...options });
        this.isSpeaking = true;
        queueMicrotask(() => this.emit('playback_started', { id: options.id }));
        return options.id;
    }

    cancel() {
        this.cancelled += 1;
        this.isSpeaking = false;
        this.emit('cancelled', { id: 'old-segment' });
    }
}

test('encola segmentos sanitizados en orden y expone auditoría', async () => {
    const player = new FakePlayer();
    const events = [];
    const service = new SpeechPlaybackService({ player, notify: event => events.push(event) });

    const result = service.speak('**Pedido confirmado**. Total: S/ 22.50.', {
        sessionId: 'session-live',
        mesa: 'M8',
        source: 'asr',
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(player.sent.map(item => item.text), [
        'Pedido confirmado.',
        'Total.',
        'Veintidós soles con cincuenta céntimos.',
    ]);
    assert.equal(result.prepared.displayText, '**Pedido confirmado**. Total: S/ 22.50.');
    assert.equal(events.some(event => event.event === 'speech_sanitization_completed'), true);
    assert.equal(events.some(event => event.event === 'tts_queue_created'), true);
    assert.equal(events.some(event => event.event === 'tts_segment_started'), true);
    const queue = events.find(event => event.event === 'tts_queue_created');
    const started = events.find(event => event.event === 'tts_segment_started');
    assert.equal(started.queue_id, queue.queue_id);
});

test('rechaza una sesión obsoleta y cancelar no muta el pedido', () => {
    const player = new FakePlayer();
    const events = [];
    const service = new SpeechPlaybackService({
        player,
        notify: event => events.push(event),
        isSessionActive: sessionId => sessionId === 'session-current',
    });

    const stale = service.speak('Respuesta de la sesión anterior.', {
        sessionId: 'session-old',
        source: 'asr',
    });
    assert.deepEqual(stale.ids, []);
    assert.equal(events.some(event => event.event === 'stale_tts_rejected'), true);

    const current = service.speak('Respuesta actual.', { sessionId: 'session-current', source: 'asr' });
    service.cancel({ reason: 'user_interrupted', sessionId: 'session-current' });
    assert.equal(current.ids.length, 1);
    assert.equal(player.cancelled >= 2, true);
    assert.equal(service.diagnostics().current, null);
});

test('repetir reutiliza texto ya procesado sin crear una petición LLM', () => {
    const player = new FakePlayer();
    const service = new SpeechPlaybackService({ player });
    const prepared = service.prepare('**Listo**. Mesa: M4.', { source: 'asr' });
    const result = service.repeat(prepared, { sessionId: 'session-repeat', source: 'ui' });

    assert.equal(result.prepared.speechText, 'Listo. Mesa cuatro.');
    assert.equal(player.sent.length, 2);
    assert.equal(player.sent.at(-1).text, 'Mesa cuatro.');
});

test('el puente de ROS2 simulado entrega el contrato de voz al reproductor', () => {
    const player = new FakePlayer();
    const playback = new SpeechPlaybackService({ player });
    const simulator = new Ros2DeliverySimulator({ pedidoRepo: {}, logger: { warn: () => {} } });
    simulator.setSpeechHandler((payload) => playback.speak(payload, { source: 'ros2_test' }));

    simulator.speak('Voy a la mesa M8. Total: S/ 22.50.');

    assert.deepEqual(player.sent.map(item => item.text), [
        'Voy a la mesa ocho.',
        'Total.',
        'Veintidós soles con cincuenta céntimos.',
    ]);
});

test('dos sesiones consecutivas invalidan el audio anterior sin mezclarlo', () => {
    const player = new FakePlayer();
    const events = [];
    const service = new SpeechPlaybackService({ player, notify: event => events.push(event) });

    const first = service.speak('Respuesta de la sesión A.', { sessionId: 'session-a', source: 'asr' });
    const second = service.speak('Respuesta de la sesión B.', { sessionId: 'session-b', source: 'asr' });
    player.emit('playback_completed', { id: first.ids[0] });

    assert.equal(service.diagnostics().current.session_id, 'session-b');
    assert.equal(player.sent.at(-1).text, 'Respuesta de la sesión B.');
    assert.equal(events.some(event => event.event === 'stale_tts_rejected' && event.segment_id === first.ids[0]), true);
    assert.equal(events.some(event => event.event === 'tts_segment_completed' && event.session_id === 'session-a'), false);
    assert.equal(second.ids.length, 1);
});
