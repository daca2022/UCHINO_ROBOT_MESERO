import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';

const PORT_WS = 3006;
const wss = new WebSocketServer({ port: PORT_WS });

console.log(`[WS] Servidor de prueba de altavoces en puerto ${PORT_WS}`);
console.log(`[!] Esperando a que el ESP32 se conecte en /ws/speaker...`);

let arecordProcess = null;

wss.on('connection', (ws, req) => {
    if (req.url !== '/ws/speaker') {
        ws.close();
        return;
    }

    console.log('[WS] ¡ESP32 Conectado!');
    console.log('[🎤] Capturando micrófono de la laptop y transmitiendo en vivo al robot...');

    // Capturar audio del micrófono de la laptop (Estéreo, Baja Latencia, RAW)
    // -t raw: evita enviar la cabecera WAV que produce ruido fuerte al principio
    arecordProcess = spawn('arecord', ['-t', 'raw', '-f', 'S16_LE', '-r', '16000', '-c', '2', '--buffer-time=50000', '--period-time=10000']);

    arecordProcess.stdout.on('data', (data) => {
        if (ws.readyState === ws.OPEN) {
            // REDUCIR VOLUMEN AL 20% PARA EVITAR RUIDO FUERTE / ACOPLE
            // Cada muestra son 2 bytes (16-bit)
            for (let i = 0; i < data.length - 1; i += 2) {
                let sample = data.readInt16LE(i);
                sample = Math.floor(sample * 0.50); // 50% de volumen
                data.writeInt16LE(sample, i);
            }
            ws.send(data);
        }
    });

    arecordProcess.stderr.on('data', (data) => {
        // Ignorar warnings comunes de ALSA
    });

    ws.on('close', () => {
        console.log('[WS] ESP32 Desconectado. Deteniendo grabación...');
        if (arecordProcess) {
            arecordProcess.kill();
            arecordProcess = null;
        }
    });
});
