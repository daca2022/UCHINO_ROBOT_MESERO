import { WebSocket } from 'ws';

const WS_URL = 'ws://localhost:3003/ws/robot';

console.log(`[TEST] Conectando a ${WS_URL}...`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('[TEST] Conexión abierta');
    
    // Enviar un heartbeat JSON
    ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
    console.log('[TEST] Heartbeat enviado');
    
    // Cerrar después de 1 segundo
    setTimeout(() => {
        console.log('[TEST] Cerrando conexión...');
        ws.close(1000, 'Test complete');
    }, 1000);
});

ws.on('message', (data, isBinary) => {
    if (isBinary) {
        console.log(`[TEST] Recibido mensaje binario: ${data.length} bytes`);
    } else {
        console.log(`[TEST] Recibido texto: ${data.toString()}`);
    }
});

ws.on('close', (code, reason) => {
    console.log(`[TEST] Conexión cerrada: ${code} ${reason}`);
});

ws.on('error', (err) => {
    console.error(`[TEST] Error: ${err.message}`);
});
