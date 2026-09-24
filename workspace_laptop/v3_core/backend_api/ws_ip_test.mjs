import { WebSocket } from 'ws';
const ws = new WebSocket('ws://192.168.100.42:3003/ws/robot');

ws.on('open', () => {
    console.log('[IP-TEST] Connected');
    ws.send(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
    setTimeout(() => ws.close(1000, 'Done'), 500);
});

ws.on('message', (data) => {
    console.log('[IP-TEST] Received:', data.toString());
});

ws.on('close', (code, reason) => {
    console.log('[IP-TEST] Closed:', code, reason);
});

ws.on('error', (err) => {
    console.error('[IP-TEST] Error:', err.message);
});
