import test from 'node:test';
import assert from 'node:assert/strict';
import { HardwareControlService } from '../../src/application/HardwareControlService.mjs';

class FakeTcpSink {
    constructor() {
        this.frames = [];
    }

    write(frame) {
        this.frames.push(Buffer.from(frame));
        return true;
    }
}

test('HardwareControlService sends volume frames through registered TCP sink', () => {
    const service = new HardwareControlService({ logger: { log() {}, warn() {} } });
    const sink = new FakeTcpSink();
    service.registerAudioSink(sink, { transport: 'tcp' });

    const result = service.setAudioVolume(70);

    assert.equal(result.applied, true);
    assert.equal(result.connected_tcp_sinks, 1);
    assert.equal(sink.frames.length, 2);
    assert.equal(sink.frames[1][0], 0xA5);
    assert.equal(sink.frames[1][1], 0x04);
    assert.match(sink.frames[1].subarray(6).toString(), /"volume":70/);
});

test('HardwareControlService sends test tone PCM through registered TCP sink', () => {
    const service = new HardwareControlService({ logger: { log() {}, warn() {} } });
    const sink = new FakeTcpSink();
    service.registerAudioSink(sink, { transport: 'tcp' });

    const result = service.sendTestTone({ frequencyHz: 440, durationMs: 100, volumePct: 20 });

    assert.equal(result.applied, true);
    assert.equal(result.connected_tcp_sinks, 1);
    assert.equal(sink.frames.at(-1)[0], 0xA5);
    assert.equal(sink.frames.at(-1)[1], 0x01);
    assert.equal(sink.frames.at(-1).readUInt16BE(4), 3200);
});
