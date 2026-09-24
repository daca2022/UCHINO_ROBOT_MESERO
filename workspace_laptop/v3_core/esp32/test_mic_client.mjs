import net from 'net';
import { spawn } from 'child_process';

const PORT = 3011;
const HOST = '127.0.0.1';
const MAGIC_BYTE = 0xA5;
const TYPE_PCM_STEREO = 0x02;
const TYPE_COMPASS = 0x03;

console.log(`[MIC CLIENT] Conectando a TCP ${HOST}:${PORT}...`);
const client = new net.Socket();

function calculateDb(val) {
    if (val === 0) return -100;
    return 20 * Math.log10(val / 32768.0);
}

client.connect(PORT, HOST, () => {
    console.log('[MIC CLIENT] Conectado al backend TCP Lab!');
    console.log('[MIC CLIENT] Capturando micro de la laptop (arecord) y enviando...');
    
    const arecord = spawn('arecord', ['-t', 'raw', '-f', 'S16_LE', '-r', '16000', '-c', '2', '--buffer-time=50000', '--period-time=10000']);
    
    let packetSeq = 0;
    
    arecord.stdout.on('data', (chunk) => {
        // Enviar audio PCM
        const header = Buffer.alloc(6);
        header.writeUInt8(MAGIC_BYTE, 0);
        header.writeUInt8(TYPE_PCM_STEREO, 1);
        header.writeUInt16BE(packetSeq & 0xFFFF, 2);
        header.writeUInt16BE(chunk.length, 4);
        
        client.write(header);
        client.write(chunk);
        
        // Calcular RMS y Pico para L y R
        let sumL = 0, sumR = 0;
        let peakL = 0, peakR = 0;
        const numSamples = Math.floor(chunk.length / 4); // 2 bytes per channel = 4 bytes per sample
        
        for (let i = 0; i < chunk.length - 3; i += 4) {
            const valL = chunk.readInt16LE(i);
            const valR = chunk.readInt16LE(i + 2);
            
            sumL += valL * valL;
            sumR += valR * valR;
            
            const absL = Math.abs(valL);
            const absR = Math.abs(valR);
            if (absL > peakL) peakL = absL;
            if (absR > peakR) peakR = absR;
        }
        
        const rmsL = Math.sqrt(sumL / numSamples);
        const rmsR = Math.sqrt(sumR / numSamples);
        
        const dbRmsL = calculateDb(rmsL);
        const dbPeakL = calculateDb(peakL);
        const dbRmsR = calculateDb(rmsR);
        const dbPeakR = calculateDb(peakR);
        
        // Enviar telemetría cada 10 paquetes aprox
        if (packetSeq % 10 === 0) {
            const telemetry = {
                mic_left_rms_db: dbRmsL,
                mic_left_peak_db: dbPeakL,
                mic_right_rms_db: dbRmsR,
                mic_right_peak_db: dbPeakR,
                doa_deg: 0,
                volL: dbRmsL,
                volR: dbRmsR,
                angle: 0
            };
            
            const jsonStr = JSON.stringify(telemetry);
            const jsonBuf = Buffer.from(jsonStr, 'utf8');
            
            const metaHeader = Buffer.alloc(6);
            metaHeader.writeUInt8(MAGIC_BYTE, 0);
            metaHeader.writeUInt8(TYPE_COMPASS, 1);
            metaHeader.writeUInt16BE(packetSeq & 0xFFFF, 2);
            metaHeader.writeUInt16BE(jsonBuf.length, 4);
            
            client.write(metaHeader);
            client.write(jsonBuf);
        }
        
        packetSeq++;
    });
    
    arecord.stderr.on('data', (data) => {});
    
    arecord.on('close', (code) => {
        client.destroy();
    });
});

client.on('error', (err) => {
    console.error(`[MIC CLIENT] Error TCP: ${err.message}`);
});

client.on('close', () => {
    process.exit(0);
});
