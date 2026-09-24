import { WebSocketServer } from 'ws';

const PORT_WS = 3003;
const wss = new WebSocketServer({ port: PORT_WS });

console.log(`[WS] Servidor LOOPBACK (V3 Protocol) en puerto ${PORT_WS}`);
console.log(`[!] Esperando a que el ESP32 se conecte en /ws/robot...`);

const MAGIC_BYTE = 0xA5;
const TYPE_PCM_STEREO = 0x02;
const TYPE_COMPASS = 0x03;

wss.on('connection', (ws, req) => {
    if (req.url !== '/ws/robot') {
        console.log(`[WS] Conexión rechazada: ${req.url}`);
        ws.close();
        return;
    }

    console.log('[WS] ¡ESP32 Conectado (V3 Protocol)!');
    console.log('[🔄] Iniciando prueba de Loopback (Micrófono -> Servidor -> Altavoz)...');

    ws.on('message', (message, isBinary) => {
        if (!isBinary) {
            // Mensajes JSON (como Heartbeat)
            try {
                const text = message.toString();
                const json = JSON.parse(text);
                if (json.type === 'heartbeat') {
                    // console.log('[Heartbeat]', json.timestamp);
                }
            } catch (e) { }
            return;
        }

        // Mensajes Binarios
        if (message.length >= 6 && message[0] === MAGIC_BYTE) {
            const type = message[1];

            if (type === TYPE_PCM_STEREO) {
                // Es un paquete de audio (Micrófono)
                const packetSeq = message.readUInt16BE(2);
                const len = message.readUInt16BE(4);

                // Extraer el payload PCM (empieza en el byte 6)
                if (message.length >= 6 + len) {
                    const audioPayload = Buffer.alloc(len);
                    message.copy(audioPayload, 0, 6, 6 + len);

                    // --- REDUCCIÓN DE VOLUMEN PARA EVITAR ACOPLE (FEEDBACK) ---
                    // El audio es 16-bit Little Endian (2 bytes por muestra)
                    for (let i = 0; i < audioPayload.length - 1; i += 2) {
                        let sample = audioPayload.readInt16LE(i);
                        sample = Math.floor(sample * 0.50); // 30% del volumen original
                        audioPayload.writeInt16LE(sample, i);
                    }

                    // Construir el paquete de respuesta para el Altavoz
                    // Usamos el mismo formato de cabecera
                    const responsePacket = Buffer.alloc(6 + len);
                    responsePacket[0] = MAGIC_BYTE;
                    responsePacket[1] = TYPE_PCM_STEREO;
                    responsePacket.writeUInt16BE(packetSeq, 2);
                    responsePacket.writeUInt16BE(len, 4);
                    audioPayload.copy(responsePacket, 6);

                    // Enviar de vuelta al ESP32
                    if (ws.readyState === ws.OPEN) {
                        ws.send(responsePacket);
                    }
                }
            } else if (type === TYPE_COMPASS) {
                // Metadatos del radar
                const metaLen = message.readUInt16BE(4);
                if (message.length >= 6 + metaLen) {
                    const jsonStr = message.toString('utf8', 6, 6 + metaLen);
                    try {
                        const radar = JSON.parse(jsonStr);
                        // console.log(`[Radar] Angulo: ${radar.angle.toFixed(1)}° | L: ${radar.volL.toFixed(1)}dB | R: ${radar.volR.toFixed(1)}dB`);
                    } catch (e) { }
                }
            }
        }
    });

    ws.on('close', () => {
        console.log('[WS] ESP32 Desconectado.');
    });
});
