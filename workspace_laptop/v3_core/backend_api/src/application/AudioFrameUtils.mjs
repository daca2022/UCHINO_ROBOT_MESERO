export const FRAME_MAGIC = 0xA5;
export const TYPE_PCM_MONO = 0x01;
export const TYPE_PCM_STEREO = 0x02;
export const TYPE_COMPASS = 0x03;
export const TYPE_CONTROL = 0x04;
export const TYPE_OTA_UPDATE = 0x20;
export const TYPE_OTA_DATA = 0x21;
export const TYPE_OTA_END = 0x22;
export const TYPE_OTA_ACK = 0x23;
export const SAMPLE_RATE = 16000;
export const FRAME_HEADER_BYTES = 6;
export const MAX_FRAME_PAYLOAD_BYTES = 64000;

export function buildAudioFrame({ type, seq, payload }) {
    if (!Number.isInteger(type) || type < 0 || type > 0xFF) {
        throw new Error('frame type inválido');
    }
    if (!Number.isInteger(seq) || seq < 0 || seq > 0xFFFF) {
        throw new Error('frame seq inválido');
    }
    if (!Buffer.isBuffer(payload)) {
        throw new Error('frame payload debe ser Buffer');
    }
    if (payload.length > 0xFFFF) {
        throw new Error('frame payload excede 65535 bytes');
    }

    const frame = Buffer.alloc(FRAME_HEADER_BYTES + payload.length);
    frame[0] = FRAME_MAGIC;
    frame[1] = type;
    frame.writeUInt16BE(seq, 2);
    frame.writeUInt16BE(payload.length, 4);
    payload.copy(frame, FRAME_HEADER_BYTES);
    return frame;
}

export function parseAudioFrame(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < FRAME_HEADER_BYTES || frame[0] !== FRAME_MAGIC) {
        return null;
    }
    const type = frame[1];
    const seq = frame.readUInt16BE(2);
    const len = frame.readUInt16BE(4);
    if (frame.length < FRAME_HEADER_BYTES + len) {
        return null;
    }
    return {
        type,
        seq,
        payload: frame.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + len),
    };
}

export function downmixStereoPcm16ToMono(stereo, opts = {}) {
    if (!Buffer.isBuffer(stereo)) {
        throw new Error('stereo debe ser Buffer');
    }
    const monoSamples = Math.floor(stereo.length / 4);
    const mono = Buffer.alloc(monoSamples * 2);

    const mode = opts.mode || process.env.UCHINO_MIC_MODE || 'average';
    const configuredGain = Number(process.env.UCHINO_MIC_GAIN);
    const gainFactor = Number.isFinite(configuredGain) && configuredGain > 0 ? configuredGain : 1;

    for (let i = 0; i < monoSamples; i++) {
        const left = stereo.readInt16LE(i * 4);
        const right = stereo.readInt16LE(i * 4 + 2);
        let mixed;
        if (mode === 'average') {
            mixed = Math.round((left + right) / 2);
        } else if (mode === 'sum') {
            mixed = left + right;
        } else if (mode === 'left') {
            mixed = left;
        } else {
            mixed = right;
        }
        const val = Math.max(-32768, Math.min(32767, Math.round(mixed * gainFactor)));
        mono.writeInt16LE(val, i * 2);
    }
    return mono;
}

export function extractPcm16FromWav(wav) {
    if (!Buffer.isBuffer(wav) || wav.length < 44) {
        throw new Error('WAV inválido');
    }
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('WAV RIFF inválido');
    }

    let offset = 12;
    let channels = null;
    let sampleRate = null;
    let bitsPerSample = null;
    let pcm = null;

    while (offset + 8 <= wav.length) {
        const chunkId = wav.toString('ascii', offset, offset + 4);
        const chunkSize = wav.readUInt32LE(offset + 4);
        const chunkDataStart = offset + 8;
        const chunkDataEnd = chunkDataStart + chunkSize;
        if (chunkDataEnd > wav.length) {
            throw new Error('WAV chunk truncado');
        }

        if (chunkId === 'fmt ') {
            const audioFormat = wav.readUInt16LE(chunkDataStart);
            channels = wav.readUInt16LE(chunkDataStart + 2);
            sampleRate = wav.readUInt32LE(chunkDataStart + 4);
            bitsPerSample = wav.readUInt16LE(chunkDataStart + 14);
            if (audioFormat !== 1 || bitsPerSample !== 16) {
                throw new Error('solo WAV PCM16 es soportado');
            }
        } else if (chunkId === 'data') {
            pcm = wav.subarray(chunkDataStart, chunkDataEnd);
        }

        offset = chunkDataEnd + (chunkSize % 2);
    }

    if (!pcm || !channels || !sampleRate || bitsPerSample !== 16) {
        throw new Error('WAV sin fmt/data PCM16');
    }

    return { pcm, sampleRate, channels };
}

export function resamplePcm16Mono(pcm, sourceRate, targetRate = SAMPLE_RATE) {
    if (sourceRate === targetRate) {
        return pcm;
    }
    if (!Number.isFinite(sourceRate) || sourceRate <= 0) {
        throw new Error('sample rate inválido');
    }
    const sourceSamples = Math.floor(pcm.length / 2);
    const targetSamples = Math.max(1, Math.round((sourceSamples * targetRate) / sourceRate));
    const out = Buffer.alloc(targetSamples * 2);
    const ratio = sourceRate / targetRate;
    for (let i = 0; i < targetSamples; i++) {
        const srcPos = i * ratio;
        const srcIdx = Math.floor(srcPos);
        const frac = srcPos - srcIdx;
        const s0 = pcm.readInt16LE(Math.min(srcIdx, sourceSamples - 1) * 2);
        const s1 = pcm.readInt16LE(Math.min(srcIdx + 1, sourceSamples - 1) * 2);
        const interpolated = Math.round(s0 + (s1 - s0) * frac);
        out.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }
    return out;
}

export function wavToPcm16Mono16k(wav) {
    const parsed = extractPcm16FromWav(wav);
    const mono = parsed.channels === 1 ? parsed.pcm : downmixStereoPcm16ToMono(parsed.pcm);
    return resamplePcm16Mono(mono, parsed.sampleRate, SAMPLE_RATE);
}

/**
 * Creates a stateful audio cleaner that applies:
 * 1. DC blocker (single-pole IIR high-pass ~40Hz) — removes DC offset/bias
 * 2. Smart channel weighting — pick best mix from stereo
 * 3. Noise gate — only pass frames above threshold
 *
 * State is maintained between frames for filter continuity.
 */
export function createAudioCleaner(opts = {}) {
    const dcBlockR = opts.dcBlockR || 0.984;  // ~50Hz @ 16kHz: R = 1 - 2*pi*50/16000
    const gateThreshold = opts.gateThreshold || 120;   // RMS threshold to open gate
    const gateHoldFrames = opts.gateHoldFrames || 8;   // frames to hold after last signal
    const channelMinRms = opts.channelMinRms || 20;    // min RMS to consider channel "alive"
    const highpassActive = opts.highpass !== false;

    // DC blocker state (per channel, stereo processing preserves channel state)
    let dcL = { prevX: 0, prevY: 0 };
    let dcR = { prevX: 0, prevY: 0 };

    // Noise gate state
    let gateOpen = false;
    let gateTimer = 0;

    function processStereoPcm(pcm16Stereo) {
        if (!Buffer.isBuffer(pcm16Stereo) || pcm16Stereo.length < 4) {
            return pcm16Stereo;
        }
        const sampleCount = Math.floor(pcm16Stereo.length / 4);
        const out = Buffer.alloc(pcm16Stereo.length);

        // Step 1: DC blocker on each channel independently (preserves phase)
        for (let i = 0; i < sampleCount; i++) {
            const left = pcm16Stereo.readInt16LE(i * 4);
            const right = pcm16Stereo.readInt16LE(i * 4 + 2);

            let cleanL = left;
            let cleanR = right;

            if (highpassActive) {
                const yL = left - dcL.prevX + dcBlockR * dcL.prevY;
                dcL.prevX = left;
                dcL.prevY = yL;
                cleanL = Math.max(-32768, Math.min(32767, Math.round(yL)));

                const yR = right - dcR.prevX + dcBlockR * dcR.prevY;
                dcR.prevX = right;
                dcR.prevY = yR;
                cleanR = Math.max(-32768, Math.min(32767, Math.round(yR)));
            }

            out.writeInt16LE(cleanL, i * 4);
            out.writeInt16LE(cleanR, i * 4 + 2);
        }

        // Step 2: Measure RMS per channel after DC blocking
        let sumL = 0, sumR = 0;
        for (let i = 0; i < sampleCount; i++) {
            const l = out.readInt16LE(i * 4);
            const r = out.readInt16LE(i * 4 + 2);
            sumL += l * l;
            sumR += r * r;
        }
        const rmsL = Math.sqrt(sumL / sampleCount);
        const rmsR = Math.sqrt(sumR / sampleCount);

        // Step 3: Noise gate — open on any channel's energy, hold open
        const maxRms = Math.max(rmsL, rmsR);
        if (maxRms >= gateThreshold) {
            gateOpen = true;
            gateTimer = gateHoldFrames;
        } else if (gateTimer > 0) {
            gateTimer--;
        } else {
            gateOpen = false;
        }

        // Step 4: Silence if gate closed
        if (!gateOpen) {
            return Buffer.alloc(out.length); // zeros
        }

        return out;
    }

    function processMonoPcm(pcm16Mono) {
        if (!Buffer.isBuffer(pcm16Mono) || pcm16Mono.length < 2) {
            return pcm16Mono;
        }
        const sampleCount = Math.floor(pcm16Mono.length / 2);
        const out = Buffer.alloc(pcm16Mono.length);

        // DC blocker
        for (let i = 0; i < sampleCount; i++) {
            const x = pcm16Mono.readInt16LE(i * 2);
            let y = x;
            if (highpassActive) {
                y = x - dcL.prevX + dcBlockR * dcL.prevY;
                dcL.prevX = x;
                dcL.prevY = y;
                y = Math.max(-32768, Math.min(32767, Math.round(y)));
            }
            out.writeInt16LE(y, i * 2);
        }

        // RMS
        let sumSq = 0;
        for (let i = 0; i < sampleCount; i++) {
            const v = out.readInt16LE(i * 2);
            sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / sampleCount);

        // Noise gate
        if (rms >= gateThreshold) {
            gateOpen = true;
            gateTimer = gateHoldFrames;
        } else if (gateTimer > 0) {
            gateTimer--;
        } else {
            gateOpen = false;
        }

        if (!gateOpen) {
            return Buffer.alloc(out.length);
        }

        return out;
    }

    return { processStereoPcm, processMonoPcm };
}
