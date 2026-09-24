import { WebSocket } from 'ws';

const WS_URL = 'ws://localhost:3003/ws/robot';

console.log(`[VAD-TEST] Conectando a ${WS_URL}...`);

const ws = new WebSocket(WS_URL);

const MAGIC_BYTE = 0xA5;
const TYPE_PCM_STEREO = 0x02;

function createAudioPacket(seq, samples, freq = 1000) {
    const payload = Buffer.alloc(samples * 2 * 2); // stereo, 16-bit
    for (let i = 0; i < samples; i++) {
        const sample = Math.sin(2 * Math.PI * freq * i / 16000) * 16000;
        payload.writeInt16LE(Math.round(sample), i * 4);
        payload.writeInt16LE(Math.round(sample), i * 4 + 2);
    }
    
    const packet = Buffer.alloc(6 + payload.length);
    packet[0] = MAGIC_BYTE;
    packet[1] = TYPE_PCM_STEREO;
    packet.writeUInt16BE(seq, 2);
    packet.writeUInt16BE(payload.length, 4);
    payload.copy(packet, 6);
    
    return packet;
}

function createSilentPacket(seq, samples) {
    const payload = Buffer.alloc(samples * 2 * 2); // all zeros = silence
    
    const packet = Buffer.alloc(6 + payload.length);
    packet[0] = MAGIC_BYTE;
    packet[1] = TYPE_PCM_STEREO;
    packet.writeUInt16BE(seq, 2);
    packet.writeUInt16BE(payload.length, 4);
    payload.copy(packet, 6);
    
    return packet;
}

ws.on('open', () => {
    console.log('[VAD-TEST] Conexión abierta');
    
    // Enviar 5 frames de audio con señal (no silencio)
    // 320 samples = 10ms @ 16kHz stereo
    for (let i = 1; i <= 5; i++) {
        setTimeout(() => {
            const packet = createAudioPacket(i, 320);
            ws.send(packet);
            console.log(`[VAD-TEST] Enviado frame ${i} (con audio)`);
        }, i * 50);
    }
    
    // Enviar 4 frames de silencio para trigger VAD
    for (let i = 6; i <= 9; i++) {
        setTimeout(() => {
            const packet = createSilentPacket(i, 320);
            ws.send(packet);
            console.log(`[VAD-TEST] Enviado frame ${i} (silencio)`);
        }, 300 + (i - 5) * 50);
    }
    
    // Cerrar después de 3 segundos
    setTimeout(() => {
        console.log('[VAD-TEST] Cerrando conexión...');
        ws.close(1000, 'VAD test complete');
    }, 3000);
});

ws.on('message', (data, isBinary) => {
    if (isBinary) {
        console.log(`[VAD-TEST] Recibido mensaje binario: ${data.length} bytes`);
        if (data.length >= 6 && data[0] === 0xA5) {
            const type = data[1];
            const seq = data.readUInt16BE(2);
            const len = data.readUInt16BE(4);
            console.log(`[VAD-TEST]  - Type: 0x${type.toString(16).toUpperCase()}`);
            console.log(`[VAD-TEST]  - Seq: ${seq}`);
            console.log(`[VAD-TEST]  - Len: ${len}`);
        }
    } else {
        console.log(`[VAD-TEST] Recibido texto: ${data.toString()}`);
    }
});

ws.on('close', (code, reason) => {
    console.log(`[VAD-TEST] Conexión cerrada: ${code} ${reason}`);
});

ws.on('error', (err) => {
    console.error(`[VAD-TEST] Error: ${err.message}`);
});
