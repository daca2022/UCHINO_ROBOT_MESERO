/**
 * Voice client for browser mic → backend binary WS /ws/robot.
 *
 * Binary protocol (matches backend expectation in src/index.mjs:743-758):
 *   byte 0:  0xA5 (magic)
 *   byte 1:  type (0x01 = mono PCM16, 0x02 = stereo PCM16)
 *   bytes 2-3: sequence number (uint16 BE)
 *   bytes 4-5: payload length in bytes (uint16 BE)
 *   bytes 6+:  PCM payload
 *
 * Audio: 16 kHz, mono, int16 LE. ~80 ms chunks (1280 samples = 2560 bytes).
 *
 * Responses from server: same 0xA5 format, type 0x02, PCM16 audio
 * (or 0x01 if mono). We concatenate chunks and play via AudioContext.
 */

const MAGIC = 0xa5;
const TYPE_MONO = 0x01;
const SAMPLE_RATE = 16000;
const SAMPLES_PER_CHUNK = 1280; // 80 ms
const BYTES_PER_CHUNK = SAMPLES_PER_CHUNK * 2; // int16
const HEADER_SIZE = 6;
const MAX_PAYLOAD = 64000;

export class VoiceClient extends EventTarget {
  constructor({ url, clientId, sessionId, mesa } = {}) {
    super();
    const baseUrl = url || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/robot`;
    const cid = clientId || this._getOrCreateClientId();
    this.clientId = cid;
    const params = new URLSearchParams({ clientId: cid });
    if (sessionId) params.set('sessionId', sessionId);
    if (mesa) params.set('mesa', mesa);
    this.url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${params.toString()}`;
    this.ws = null;
    this.stream = null;
    this.audioCtx = null;
    this.processor = null;
    this.seq = 0;
    this.running = false;
    this.responseChunks = [];
  }

  _getOrCreateClientId() {
    const KEY = 'chipi_client_id';
    try {
      let cid = localStorage.getItem(KEY);
      if (!cid) {
        cid = (crypto?.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
        localStorage.setItem(KEY, cid);
      }
      return cid;
    } catch {
      return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Browser does not support getUserMedia');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE,
    });
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
    source.connect(this.processor);
    this.processor.connect(this.audioCtx.destination);

    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.emit('connected');
    this.ws.onclose = () => this.emit('disconnected');
    this.ws.onerror = (e) => this.emit('error', e);
    this.ws.onmessage = (e) => this.handleIncoming(e.data);

    this.processor.onaudioprocess = (e) => this.handleAudioFrame(e.inputBuffer.getChannelData(0));
    this.running = true;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this._responseDoneTimer) {
      clearTimeout(this._responseDoneTimer);
      this._responseDoneTimer = null;
    }
    this.responseChunks = [];
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      await this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }

  handleAudioFrame(float32) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const payload = new Uint8Array(int16.buffer);
    let offset = 0;
    while (offset < payload.length) {
      const slice = payload.subarray(offset, Math.min(offset + MAX_PAYLOAD, payload.length));
      this.sendPacket(TYPE_MONO, slice);
      offset += slice.length;
    }
  }

  sendPacket(type, payload) {
    const packet = new ArrayBuffer(HEADER_SIZE + payload.length);
    const view = new DataView(packet);
    view.setUint8(0, MAGIC);
    view.setUint8(1, type);
    view.setUint16(2, this.seq & 0xffff, false);
    view.setUint16(4, payload.length, false);
    new Uint8Array(packet, HEADER_SIZE).set(payload);
    this.ws.send(packet);
    this.seq = (this.seq + 1) & 0xffff;
  }

  handleIncoming(data) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        this.emit('message', msg);
      } catch {}
      return;
    }
    const view = new DataView(data);
    if (view.getUint8(0) !== MAGIC) return;
    const type = view.getUint8(1);
    const len = view.getUint16(4, false);
    const payload = new Uint8Array(data, HEADER_SIZE, len);
    if (type === TYPE_MONO || type === 0x02) {
      this.responseChunks.push(payload);
      this.emit('response_chunk', payload);
      if (this._responseDoneTimer) clearTimeout(this._responseDoneTimer);
      this._responseDoneTimer = setTimeout(() => {
        this.playResponse();
      }, 600);
    }
  }

  async playResponse() {
    if (this.responseChunks.length === 0 || !this.audioCtx) return;
    if (this.audioCtx.state === 'suspended') {
      try { await this.audioCtx.resume(); } catch {}
    }
    const totalLen = this.responseChunks.reduce((s, c) => s + c.length, 0);
    const int16 = new Int16Array(totalLen / 2);
    let off = 0;
    for (const chunk of this.responseChunks) {
      const view = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
      int16.set(view, off);
      off += view.length;
    }
    this.responseChunks = [];
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const buffer = this.audioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioCtx.destination);
    this.emit('response_start', { durationMs: (float32.length / SAMPLE_RATE) * 1000 });
    source.onended = () => {
      this.emit('response_end');
    };
    source.start(0);
    await new Promise((resolve) => {
      source.onended = resolve;
    });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
