import { WebSocketServer, WebSocket } from 'ws';

const wss = new WebSocketServer({ port: 9999 });

wss.on('connection', (ws) => {
    console.log('[SERVER] Client connected');
    
    ws.on('message', (data, isBinary) => {
        console.log(`[SERVER] Received: ${data.length} bytes, binary: ${isBinary}`);
        if (isBinary) {
            ws.send(data);
        } else {
            ws.send(`Echo: ${data}`);
        }
    });
    
    ws.on('close', () => {
        console.log('[SERVER] Client disconnected');
    });
});

console.log('[SERVER] Listening on ws://localhost:9999');

// Client test
setTimeout(() => {
    const client = new WebSocket('ws://localhost:9999');
    
    client.on('open', () => {
        console.log('[CLIENT] Connected');
        client.send('Hello');
        client.send(Buffer.from([0xA5, 0x02, 0x00, 0x01, 0x00, 0x10]));
        setTimeout(() => client.close(), 500);
    });
    
    client.on('message', (data, isBinary) => {
        console.log(`[CLIENT] Received: ${data.length} bytes, binary: ${isBinary}`);
    });
    
    client.on('close', () => {
        console.log('[CLIENT] Disconnected');
        wss.close();
    });
    
    client.on('error', (err) => {
        console.error(`[CLIENT] Error: ${err.message}`);
    });
}, 100);
