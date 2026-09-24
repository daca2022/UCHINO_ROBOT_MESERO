import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const app = express();
const server = createServer(app);

const wss = new WebSocketServer({ server, path: '/ws/robot' });

wss.on('connection', (ws) => {
    console.log('[SERVER] Robot connected');
    ws.on('message', (data) => {
        console.log('[SERVER] Robot received:', data.toString());
        ws.send('Echo: ' + data.toString());
    });
    ws.on('close', () => console.log('[SERVER] Robot disconnected'));
});

app.get('/api/status', (req, res) => res.json({ status: 'ok' }));

server.listen(9996, () => {
    console.log('[SERVER] Listening on http://localhost:9996');
    
    setTimeout(() => {
        const client = new WebSocket('ws://localhost:9996/ws/robot');
        
        client.on('open', () => {
            console.log('[CLIENT] Connected');
            client.send('Hello');
            setTimeout(() => client.close(), 200);
        });
        
        client.on('message', (data) => {
            console.log('[CLIENT] Received:', data.toString());
        });
        
        client.on('close', () => {
            console.log('[CLIENT] Disconnected');
            server.close();
        });
        
        client.on('error', (err) => {
            console.error('[CLIENT] Error:', err.message);
            server.close();
        });
    }, 100);
});
