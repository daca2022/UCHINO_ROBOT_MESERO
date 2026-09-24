import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import express from 'express';

const PORT_WS = 3003;
const PORT_HTTP = 3005;

// --- HTTP SERVER PARA LA UI ---
const app = express();

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Uchino - Radar de Audio 2D</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body { background-color: #0f172a; color: white; font-family: 'Inter', sans-serif; }
        .radar-circle {
            width: 300px; height: 300px; border-radius: 50%;
            border: 2px solid #334155; position: relative;
            background: radial-gradient(circle, #1e293b 0%, #0f172a 100%);
        }
        .radar-line {
            position: absolute; top: 0; left: 50%; width: 1px; height: 100%;
            background-color: #334155; transform-origin: center;
        }
        .radar-horizontal { transform: rotate(90deg); }
        .pointer {
            position: absolute; top: 50%; left: 50%; width: 4px; height: 140px;
            background: linear-gradient(to top, transparent, #3b82f6);
            transform-origin: bottom center;
            transform: translate(-50%, -100%) rotate(0deg);
            transition: transform 0.2s ease-out;
            border-radius: 4px;
        }
        .robot-center {
            position: absolute; top: 50%; left: 50%; width: 20px; height: 20px;
            background-color: #ef4444; border-radius: 50%;
            transform: translate(-50%, -50%); box-shadow: 0 0 10px #ef4444;
        }
        .bar-container { width: 100%; height: 30px; background-color: #1e293b; border-radius: 15px; overflow: hidden; position: relative;}
        .bar-fill { height: 100%; transition: width 0.1s ease-out; position: absolute; top: 0;}
        .bar-l { background-color: #10b981; left: 0; }
        .bar-r { background-color: #3b82f6; right: 0; }
    </style>
</head>
<body class="flex flex-col items-center justify-center min-h-screen p-4">
    <h1 class="text-3xl font-bold mb-2 text-blue-400">Uchino Audio Radar</h1>
    <p class="text-slate-400 mb-8 text-center max-w-md">Visualización en tiempo real del ángulo y volumen (Micrófonos INMP441).</p>

    <div class="flex flex-col md:flex-row gap-12 items-center">
        <!-- RADAR -->
        <div class="flex flex-col items-center p-6 bg-slate-800 rounded-2xl border border-slate-700 shadow-xl">
            <h2 class="text-xl font-semibold mb-4 text-slate-200">Dirección de la Voz</h2>
            <div class="radar-circle mb-4 shadow-inner">
                <div class="radar-line"></div>
                <div class="radar-line radar-horizontal"></div>
                <div class="absolute top-2 left-1/2 -translate-x-1/2 text-xs text-slate-400 font-bold">FRENTE</div>
                <div class="absolute bottom-2 left-1/2 -translate-x-1/2 text-xs text-slate-400 font-bold">ATRÁS</div>
                <div class="absolute top-1/2 left-2 -translate-y-1/2 text-xs text-slate-400 font-bold">IZQ</div>
                <div class="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-slate-400 font-bold">DER</div>
                
                <div class="pointer" id="pointer"></div>
                <div class="robot-center"></div>
            </div>
            <div class="text-3xl font-bold text-white" id="angle-text">0.0°</div>
            <div class="text-base text-slate-400 mt-1 h-6" id="direction-text">Esperando audio...</div>
            <div class="text-xs text-amber-500/80 mt-4 max-w-xs text-center leading-tight">
                * Con 2 micrófonos en línea, el "Frente" y "Atrás" producen el mismo TDoA (cono de confusión).
            </div>
        </div>

        <!-- VOLUMETROS -->
        <div class="flex flex-col gap-6 w-full max-w-sm p-6 bg-slate-800 rounded-2xl border border-slate-700 shadow-xl">
            <h2 class="text-xl font-semibold mb-2 text-slate-200">Volumen Independiente</h2>
            
            <div>
                <div class="flex justify-between mb-2">
                    <span class="font-medium text-emerald-400 flex items-center gap-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                        Izquierdo (L)
                    </span>
                    <span class="text-slate-300 font-mono" id="volL-text">-0 dB</span>
                </div>
                <div class="bar-container">
                    <div class="bar-fill bar-l" id="volL-bar" style="width: 0%"></div>
                </div>
            </div>

            <div class="mt-2">
                <div class="flex justify-between mb-2">
                    <span class="font-medium text-blue-400 flex items-center gap-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path></svg>
                        Derecho (R)
                    </span>
                    <span class="text-slate-300 font-mono" id="volR-text">-0 dB</span>
                </div>
                <div class="bar-container flex justify-end">
                    <div class="bar-fill bar-r" id="volR-bar" style="width: 0%"></div>
                </div>
            </div>
            
            <div class="mt-4 p-3 bg-slate-900 rounded-lg border border-slate-700/50 flex items-center gap-3">
                <div class="w-3 h-3 rounded-full bg-green-500 animate-pulse"></div>
                <p class="text-sm text-slate-300">
                    Reproduciendo audio en vivo en laptop...
                </p>
            </div>
        </div>
    </div>

    <script>
        const ws = new WebSocket('ws://' + window.location.hostname + ':3003/ws/ui');
        
        const pointer = document.getElementById('pointer');
        const angleText = document.getElementById('angle-text');
        const directionText = document.getElementById('direction-text');
        
        const volLBar = document.getElementById('volL-bar');
        const volLText = document.getElementById('volL-text');
        const volRBar = document.getElementById('volR-bar');
        const volRText = document.getElementById('volR-text');

        // Convertir dB (ej: -60 a 0) a porcentaje (0 a 100%)
        function dbToPercent(db) {
            if (db < -60) return 0;
            if (db > 0) return 100;
            return ((db + 60) / 60) * 100;
        }

        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                // Actualizar Radar
                let angle = data.angle;
                pointer.style.transform = \`translate(-50%, -100%) rotate(\${angle}deg)\`;
                angleText.innerText = angle.toFixed(1) + '°';
                
                if (data.volL < -55 && data.volR < -55) {
                    directionText.innerText = "Silencio";
                    directionText.className = "text-sm text-slate-500 mt-1";
                } else if (angle > 15) {
                    directionText.innerText = "DERECHA";
                    directionText.className = "text-base text-blue-400 font-bold mt-1";
                } else if (angle < -15) {
                    directionText.innerText = "IZQUIERDA";
                    directionText.className = "text-base text-emerald-400 font-bold mt-1";
                } else {
                    directionText.innerText = "FRENTE / ATRÁS";
                    directionText.className = "text-base text-white font-bold mt-1";
                }

                // Actualizar Barras de Volumen
                const pL = dbToPercent(data.volL);
                const pR = dbToPercent(data.volR);
                
                volLBar.style.width = pL + '%';
                volRBar.style.width = pR + '%';
                
                volLText.innerText = data.volL.toFixed(1) + ' dB';
                volRText.innerText = data.volR.toFixed(1) + ' dB';

            } catch(e) {}
        };
    </script>
</body>
</html>
    `);
});

app.listen(PORT_HTTP, () => {
    console.log(`[UI] Dashboard 2D interactivo disponible en: http://localhost:${PORT_HTTP}`);
});

// --- WEBSOCKET SERVER ---
const wss = new WebSocketServer({ port: PORT_WS });

// Store UI clients to broadcast telemetry
const uiClients = new Set();

console.log(`[WS] Escuchando ESP32 en ws://0.0.0.0:${PORT_WS}/ws/robot`);

wss.on('connection', (ws, req) => {
    if (req.url === '/ws/ui') {
        uiClients.add(ws);
        ws.on('close', () => uiClients.delete(ws));
        return;
    }

    if (req.url !== '/ws/robot') {
        ws.close();
        return;
    }
    
    console.log('[WS] ESP32 Conectado! Reproduciendo audio y enviando datos al dashboard...');
    
    const aplay = spawn('aplay', ['-f', 'S16_LE', '-r', '16000', '-c', '2']);
    
    aplay.stderr.on('data', (data) => {
        // Ignorar warnings comunes
    });

    ws.on('message', (message, isBinary) => {
        if (isBinary && Buffer.isBuffer(message)) {
            if (message[0] === 0xA5) {
                const type = message[1];
                const len = (message[4] << 8) | message[5];
                
                if (type === 0x02) { // TYPE_PCM_STEREO
                    const audioData = message.subarray(6, 6 + len);
                    aplay.stdin.write(audioData);
                } else if (type === 0x03) { // TYPE_COMPASS
                    const jsonStr = message.subarray(6, 6 + len).toString();
                    for (const client of uiClients) {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(jsonStr);
                        }
                    }
                }
            }
        }
    });

    ws.on('close', () => {
        console.log('[WS] ESP32 Desconectado');
        aplay.kill();
    });
});
