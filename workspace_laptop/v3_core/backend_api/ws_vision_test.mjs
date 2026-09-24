import { WebSocket } from 'ws';

const ws = new WebSocket('ws://localhost:3003/ws/vision');

ws.on('open', () => {
    console.log('[VISION] Connected');
    ws.send(JSON.stringify({ type: 'test' }));
    setTimeout(() => ws.close(1000, 'Done'), 500);
});

ws.on('message', (data) => {
    console.log(`[VISION] Received: ${data.toString()}`);
});

ws.on('close', (code, reason) => {
    console.log(`[VISION] Closed: ${code} ${reason}`);
});

ws.on('error', (err) => {
    console.error(`[VISION] Error: ${err.message}`);
});
