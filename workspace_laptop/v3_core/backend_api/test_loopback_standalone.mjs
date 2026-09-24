import { WebSocketServer, WebSocket } from 'ws';

const PORT_WS = 3004; // Different port to avoid conflict
const wss = new WebSocketServer({ port: PORT_WS });

console.log(`[WS] Servidor LOOPBACK (V3 Protocol) en puerto ${PORT_WS}`);

const MAGIC_BYTE = 0xA5;
const TYPE_PCM_STEREO = 0x02;
const TYPE_COMPASS = 0x03;

wss.on('connection', (ws, req) => {
    if (req.url !== '/ws/robot') {
        console.log(`[WS] Conexión rechazada: ${req.url}`);
        ws.close();
        return;
    }

    console.log('[WS] Cliente conectado!');

    ws.on('message', (message, isBinary) => {
        if (!isBinary) {
            try {
                const text = message.toString();
                const json = JSON.parse(text);
                if (json.type === 'heartbeat') {
                    console.log('[Heartbeat]', json.timestamp);
                }
            } catch (e) { }
            return;
        }

        if (message.length >= 6 && message[0] === MAGIC_BYTE) {
            const type = message[1];

            if (type === TYPE_PCM_STEREO) {
                const packetSeq = message.readUInt16BE(2);
                const len = message.readUInt16BE(4);

                if (message.length >= 6 + len) {
                    const audioPayload = Buffer.alloc(len);
                    message.copy(audioPayload, 0, 6, 6 + len);

                    // Reducir volumen
                    for (let i = 0; i < audioPayload.length - 1; i += 2) {
                        let sample = audioPayload.readInt16LE(i);
                        sample = Math.floor(sample * 0.50);
                        audioPayload.writeInt16LE(sample, i);
                    }

                    const responsePacket = Buffer.alloc(6 + len);
                    responsePacket[0] = MAGIC_BYTE;
                    responsePacket[1] = TYPE_PCM_STEREO;
                    responsePacket.writeUInt16BE(packetSeq, 2);
                    responsePacket.writeUInt16BE(len, 4);
                    audioPayload.copy(responsePacket, 6);

                    if (ws.readyState === ws.OPEN) {
                        ws.send(responsePacket);
                        console.log(`[Loopback] Enviado paquete ${packetSeq}, ${len} bytes`);
                    }
                }
            } else if (type === TYPE_COMPASS) {
                const metaLen = message.readUInt16BE(4);
                if (message.length >= 6 + metaLen) {
                    const jsonStr = message.toString('utf8', 6, 6 + metaLen);
                    try {
                        const radar = JSON.parse(jsonStr);
                        console.log(`[Radar] Angulo: ${radar.angle?.toFixed(1)}°`);
                    } catch (e) { }
                }
            }
        }
    });

    ws.on('close', () => {
        console.log('[WS] Cliente desconectado.');
    });
});

// Cliente de prueba
setTimeout(() => {
    const client = new WebSocket(`ws://localhost:${PORT_WS}/ws/robot`);
    
    client.on('open', () => {
        console.log('[CLIENT] Conectado al loopback');
        
        // Crear paquete de audio PCM16
        const samples = 320;
        const payload = Buffer.alloc(samples * 2 * 2);
        for (let i = 0; i < samples; i++) {
            const sample = Math.sin(2 * Math.PI * 1000 * i / 16000) * 16000;
            payload.writeInt16LE(Math.round(sample), i * 4);
            payload.writeInt16LE(Math.round(sample), i * 4 + 2);
        }
        
        const packet = Buffer.alloc(6 + payload.length);
        packet[0] = MAGIC_BYTE;
        packet[1] = TYPE_PCM_STEREO;
        packet.writeUInt16BE(1, 2);
        packet.writeUInt16BE(payload.length, 4);
        payload.copy(packet, 6);
        
        client.send(packet);
        console.log('[CLIENT] Enviado paquete de audio');
        
        setTimeout(() => client.close(), 500);
    });
    
    client.on('message', (data, isBinary) => {
        if (isBinary && data.length >= 6 && data[0] === MAGIC_BYTE) {
            const seq = data.readUInt16BE(2);
            const len = data.readUInt16BE(4);
            console.log(`[CLIENT] Recibido loopback: seq=${seq}, len=${len}`);
        }
    });
    
    client.on('close', () => {
        console.log('[CLIENT] Desconectado');
        wss.close();
    });
    
    client.on('error', (err) => {
        console.error('[CLIENT] Error:', err.message);
        wss.close();
    });
}, 100);
