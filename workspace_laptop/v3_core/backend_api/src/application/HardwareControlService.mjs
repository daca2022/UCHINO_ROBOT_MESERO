import {
    buildAudioFrame,
    MAX_FRAME_PAYLOAD_BYTES,
    SAMPLE_RATE,
    TYPE_CONTROL,
    TYPE_PCM_MONO,
    TYPE_OTA_UPDATE,
    TYPE_OTA_DATA,
    TYPE_OTA_END,
    TYPE_OTA_ACK,
} from './AudioFrameUtils.mjs';

export class HardwareControlService {
    constructor({ logger = console } = {}) {
        this.logger = logger;
        this.robotClients = new Map();
        this.audioSinks = new Map();
        this.audioVolume = 50;
        this.seq = 0;
        this.lastVolumeSentAt = null;
        this._esp32BufferFillPct = 0;
        this._esp32BufferFreeBytes = 128 * 1024;
    }

    registerRobotClient(ws, meta = {}) {
        this._pruneClients();
        const role = meta.role || 'browser';
        if (role === 'esp32') {
            this._replaceEsp32Clients(ws);
        }
        this.robotClients.set(ws, {
            role,
            clientId: meta.clientId || null,
            connectedAt: new Date().toISOString(),
            skipInitialVolume: !!meta.skipInitialVolume,
        });
        if (role === 'esp32' && !meta.skipInitialVolume) {
            this._sendAudioVolume(ws);
        }
    }

    unregisterRobotClient(ws) {
        this.robotClients.delete(ws);
    }

    registerAudioSink(sink, meta = {}) {
        this.audioSinks.clear();
        this.audioSinks.set(sink, {
            transport: meta.transport || 'tcp',
            connectedAt: new Date().toISOString(),
        });
        this._sendAudioVolumeToSink(sink);
    }

    unregisterAudioSink(sink) {
        this.audioSinks.delete(sink);
    }

    getState() {
        const clients = this._connectedClients();
        const esp32Clients = clients.filter(({ meta }) => meta.role === 'esp32');
        return {
            audio_volume: this.audioVolume,
            connected_robot_clients: clients.length,
            connected_esp32_clients: esp32Clients.length,
            connected_browser_voice_clients: clients.length - esp32Clients.length,
            connected_tcp_sinks: this.audioSinks.size,
            transport: this.audioSinks.size > 0 ? 'tcp' : 'websocket',
            last_volume_sent_at: this.lastVolumeSentAt,
        };
    }

    setAudioVolume(volume) {
        const parsed = Number(volume);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
            throw new Error('volume debe ser un entero entre 0 y 100');
        }

        this.audioVolume = parsed;
        const clients = this._connectedClients().filter(({ meta }) => meta.role === 'esp32');
        for (const { ws } of clients) {
            this._sendAudioVolume(ws);
        }
        for (const sink of this.audioSinks.keys()) {
            this._sendAudioVolumeToSink(sink);
        }

        const applied = clients.length + this.audioSinks.size > 0;
        return {
            ...this.getState(),
            applied,
            message: applied
                ? 'Volumen enviado al ESP32 de audio'
                : 'Volumen guardado; ESP32 de audio no conectado',
        };
    }

    sendTestTone({ frequencyHz = 880, durationMs = 1000, volumePct = 30 } = {}) {
        const freq = Number(frequencyHz);
        const duration = Number(durationMs);
        const volume = Number(volumePct);

        if (!Number.isFinite(freq) || freq < 100 || freq > 4000) {
            throw new Error('frequencyHz debe estar entre 100 y 4000');
        }
        if (!Number.isFinite(duration) || duration < 100 || duration > 5000) {
            throw new Error('durationMs debe estar entre 100 y 5000');
        }
        if (!Number.isFinite(volume) || volume < 1 || volume > 100) {
            throw new Error('volumePct debe estar entre 1 y 100');
        }

        const clients = this._connectedClients().filter(({ meta }) => meta.role === 'esp32');
        const pcm = this._generateTonePcm(freq, duration, volume);

        for (const { ws } of clients) {
            this._sendPcmFrames(ws, pcm, TYPE_PCM_MONO);
        }
        for (const sink of this.audioSinks.keys()) {
            this._sendPcmToSink(sink, pcm, TYPE_PCM_MONO);
        }

        const applied = clients.length + this.audioSinks.size > 0;
        return {
            ...this.getState(),
            applied,
            connected_robot_clients: clients.length,
            tone: {
                frequencyHz: freq,
                durationMs: duration,
                volumePct: volume,
                bytes: pcm.length,
            },
            message: applied
                ? 'Tono de prueba enviado al ESP32'
                : 'No hay ESP32 conectado para reproducir el tono',
        };
    }

    /**
     * Send OTA firmware binary to the ESP32 via TCP sink.
     * Steps: TYPE_OTA_UPDATE → N×TYPE_OTA_DATA → TYPE_OTA_END
     * Waits for ACK after UPDATE and each DATA chunk.
     * Returns a Promise that resolves when OTA completes or rejects on error.
     */
    sendOtaFirmware(firmwareBuf, chunkSize = 4096) {
        const sinks = [...this.audioSinks.keys()];
        if (sinks.length === 0) {
            return Promise.reject(new Error('No TCP sinks (ESP32) connected for OTA'));
        }
        this.logger.log?.('[Hardware] OTA iniciando:', firmwareBuf.length, 'bytes,', sinks.length, 'sink(s)');

        return new Promise((resolve, reject) => {
            const sink = sinks[0];
            const seqBuf = Buffer.alloc(2);
            let seq = 0;

            const waitForAck = (timeoutMs = 5000) => {
                return new Promise((ackResolve, ackReject) => {
                    const handler = (chunk) => {
                        let offset = 0;
                        while (offset < chunk.length) {
                            if (chunk[offset] !== 0xA5) { offset++; continue; }
                            if (offset + 6 > chunk.length) return;
                            const type = chunk[offset + 1];
                            const payloadLen = chunk.readUInt16BE(offset + 4);
                            if (type === TYPE_OTA_ACK) {
                                if (offset + 6 + payloadLen > chunk.length) return;
                                const status = chunk[offset + 6];
                                const bytesWritten = chunk.readUInt32BE(offset + 7);
                                cleanup();
                                if (status === 0) ackResolve(bytesWritten);
                                else ackReject(new Error(`OTA error status=${status} at offset=${bytesWritten}`));
                                return;
                            }
                            offset += 6 + payloadLen;
                        }
                    };
                    const timeout = setTimeout(() => {
                        cleanup();
                        ackReject(new Error('OTA ACK timeout'));
                    }, timeoutMs);
                    const dataHandler = (chunk) => {
                        handler(chunk);
                    };
                    sink.on('data', dataHandler);
                    const cleanup = () => {
                        clearTimeout(timeout);
                        sink.removeListener('data', dataHandler);
                    };
                });
            };

            try {
                // Step 1: TYPE_OTA_UPDATE with firmware size
                (async () => {
                    const sizeBuf = Buffer.alloc(4);
                    sizeBuf.writeUInt32BE(firmwareBuf.length);
                    seq++;
                    seqBuf.writeUInt16BE(seq);
                    let frame = buildAudioFrame(TYPE_OTA_UPDATE, sizeBuf, seq);
                    if (typeof sink.write === 'function') sink.write(frame);
                    else sink.send(frame);
                    this.logger.log?.('[Hardware] OTA UPDATE sent, size=' + firmwareBuf.length);
                    await waitForAck(10000);

                    // Step 2: Chunked TYPE_OTA_DATA
                    for (let offset = 0; offset < firmwareBuf.length; offset += chunkSize) {
                        const chunk = firmwareBuf.subarray(offset, Math.min(offset + chunkSize, firmwareBuf.length));
                        seq++;
                        seqBuf.writeUInt16BE(seq);
                        frame = buildAudioFrame(TYPE_OTA_DATA, chunk, seq);
                        if (typeof sink.write === 'function') sink.write(frame);
                        else sink.send(frame);
                        await waitForAck(5000);
                        if (offset % (chunkSize * 50) === 0) {
                            this.logger.log?.('[Hardware] OTA progress:', Math.round(offset * 100 / firmwareBuf.length) + '%');
                        }
                    }

                    // Step 3: TYPE_OTA_END
                    seq++;
                    seqBuf.writeUInt16BE(seq);
                    frame = buildAudioFrame(TYPE_OTA_END, Buffer.alloc(0), seq);
                    if (typeof sink.write === 'function') sink.write(frame);
                    else sink.send(frame);
                    this.logger.log?.('[Hardware] OTA END sent, esperando ACK final...');
                    await waitForAck(15000);

                    this.logger.log?.('[Hardware] OTA completada exitosamente!');
                    resolve(firmwareBuf.length);
                })().catch(reject);
            } catch (err) {
                reject(err);
            }
        });
    }

    sendPcm(pcm, frameType = TYPE_PCM_MONO) {
        const clients = this._connectedClients().filter(({ meta }) => meta.role === 'esp32');
        for (const { ws } of clients) {
            this._sendPcmFrames(ws, pcm, frameType);
        }
        for (const sink of this.audioSinks.keys()) {
            this._sendPcmToSink(sink, pcm, frameType);
        }
        return clients.length + this.audioSinks.size;
    }

    /**
     * Send PCM to ESP32 with paced delivery (delay between chunks).
     * Prevents ESP32 buffer overflow for long audio.
     * Returns a Promise that resolves when all chunks are sent.
     */
    sendPcmPaced(pcm, chunkDelayMs = 80, frameType = TYPE_PCM_MONO) {
        const sinks = [...this.audioSinks.keys()];
        if (sinks.length === 0) {
            this.logger.log?.('[Hardware] sendPcmPaced: no sinks');
            return Promise.resolve(0);
        }

        const chunkSize = MAX_FRAME_PAYLOAD_BYTES;
        const chunks = [];
        for (let offset = 0; offset < pcm.length; offset += chunkSize) {
            chunks.push(pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length)));
        }

        this.logger.log?.('[Hardware] sendPcmPaced:', pcm.length, 'bytes,', chunks.length, 'chunks,', sinks.length, 'sink(s), delay:', chunkDelayMs, 'ms');

        return new Promise((resolve) => {
            let i = 0;
            const sendNext = () => {
                if (i >= chunks.length) {
                    this.logger.log?.('[Hardware] PCM paced done');
                    resolve(sinks.length);
                    return;
                }
                const fillPct = this._esp32BufferFillPct || 0;
                if (fillPct > 75) {
                    this.logger.log?.(`[Hardware] backpressure: buffer ${fillPct}% > 75%, waiting 100ms`);
                    setTimeout(sendNext, 100);
                    return;
                }
                const frame = this._nextFrame(frameType, chunks[i]);
                for (const sink of sinks) {
                    if (typeof sink.send === 'function') {
                        sink.send(frame);
                    } else if (typeof sink.write === 'function') {
                        sink.write(frame);
                    }
                }
                i++;
                setTimeout(sendNext, fillPct > 40 ? chunkDelayMs * 2 : chunkDelayMs);
            };
            sendNext();
        });
    }

    _connectedClients() {
        this._pruneClients();
        return [...this.robotClients.entries()]
            .filter(([client]) => client.readyState === 1)
            .map(([ws, meta]) => ({ ws, meta }));
    }

    _pruneClients() {
        for (const [client] of this.robotClients.entries()) {
            if (client.readyState !== 1) {
                this.robotClients.delete(client);
            }
        }
    }

    _replaceEsp32Clients(nextWs) {
        for (const [client, meta] of this.robotClients.entries()) {
            if (client === nextWs || meta.role !== 'esp32') {
                continue;
            }
            this.robotClients.delete(client);
            try {
                if (client.readyState === 0 || client.readyState === 1) {
                    client.close(4001, 'superseded_by_new_esp32');
                }
            } catch (error) {
                this.logger.warn?.('[Hardware] no se pudo cerrar ESP32 previo:', error.message);
            }
        }
    }

    _sendAudioVolume(ws) {
        if (ws.readyState !== 1) return false;
        const payload = Buffer.from(JSON.stringify({ volume: this.audioVolume }));
        const frame = this._nextFrame(TYPE_CONTROL, payload);
        ws.send(frame);
        this.lastVolumeSentAt = new Date().toISOString();
        this.logger.log?.('[Hardware] Volumen ESP32 enviado:', this.audioVolume);
        return true;
    }

    _sendPcmFrames(ws, pcm, frameType) {
        if (ws.readyState !== 1) return false;
        let offset = 0;
        while (offset < pcm.length) {
            const chunkSize = Math.min(MAX_FRAME_PAYLOAD_BYTES, pcm.length - offset);
            const frame = this._nextFrame(frameType, pcm.subarray(offset, offset + chunkSize));
            ws.send(frame);
            offset += chunkSize;
        }
        this.logger.log?.('[Hardware] PCM enviado al ESP32:', pcm.length, 'bytes');
        return true;
    }

    _sendAudioVolumeToSink(sink) {
        const payload = Buffer.from(JSON.stringify({ volume: this.audioVolume }));
        const sent = this._writeSinkFrame(sink, TYPE_CONTROL, payload);
        if (sent) {
            this.lastVolumeSentAt = new Date().toISOString();
        }
        return sent;
    }

    _sendPcmToSink(sink, pcm, frameType) {
        let sent = false;
        let offset = 0;
        while (offset < pcm.length) {
            const chunkSize = Math.min(MAX_FRAME_PAYLOAD_BYTES, pcm.length - offset);
            sent = this._writeSinkFrame(sink, frameType, pcm.subarray(offset, offset + chunkSize)) || sent;
            offset += chunkSize;
        }
        return sent;
    }

    _writeSinkFrame(sink, type, payload) {
        const frame = this._nextFrame(type, payload);
        return sink.write(frame) !== false;
    }

    _nextFrame(type, payload) {
        const frame = buildAudioFrame({ type, seq: this.seq, payload });
        this.seq = (this.seq + 1) & 0xFFFF;
        return frame;
    }

    _generateTonePcm(frequencyHz, durationMs, volumePct) {
        const sampleCount = Math.floor((SAMPLE_RATE * durationMs) / 1000);
        const pcm = Buffer.alloc(sampleCount * 2);
        const amplitude = Math.floor(32767 * (volumePct / 100));
        const periodSamples = Math.max(1, Math.floor(SAMPLE_RATE / frequencyHz));
        const halfPeriod = Math.max(1, Math.floor(periodSamples / 2));
        for (let i = 0; i < sampleCount; i++) {
            const sample = (i % periodSamples) < halfPeriod ? amplitude : -amplitude;
            pcm.writeInt16LE(sample, i * 2);
        }
        return pcm;
    }
}
