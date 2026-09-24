import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAudioFrame,
    downmixStereoPcm16ToMono,
    extractPcm16FromWav,
} from '../../src/application/AudioFrameUtils.mjs';

test('buildAudioFrame writes the Uchino binary header when payload is valid', () => {
    const payload = Buffer.from([0x10, 0x20, 0x30]);

    const frame = buildAudioFrame({ type: 0x04, seq: 7, payload });

    assert.equal(frame[0], 0xA5);
    assert.equal(frame[1], 0x04);
    assert.equal(frame.readUInt16BE(2), 7);
    assert.equal(frame.readUInt16BE(4), payload.length);
    assert.deepEqual(frame.subarray(6), payload);
});

test('downmixStereoPcm16ToMono averages interleaved stereo samples', () => {
    const stereo = Buffer.alloc(8);
    stereo.writeInt16LE(1000, 0);
    stereo.writeInt16LE(-1000, 2);
    stereo.writeInt16LE(3000, 4);
    stereo.writeInt16LE(1000, 6);

    const mono = downmixStereoPcm16ToMono(stereo);

    assert.equal(mono.length, 4);
    assert.equal(mono.readInt16LE(0), 0);
    assert.equal(mono.readInt16LE(2), 2000);
});

test('extractPcm16FromWav returns raw PCM and metadata for mono PCM WAV', () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(1234, 0);
    pcm.writeInt16LE(-1234, 2);
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + pcm.length, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(pcm.length, 40);
    pcm.copy(wav, 44);

    const parsed = extractPcm16FromWav(wav);

    assert.equal(parsed.sampleRate, 16000);
    assert.equal(parsed.channels, 1);
    assert.deepEqual(parsed.pcm, pcm);
});
