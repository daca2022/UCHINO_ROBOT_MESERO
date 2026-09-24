import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import net from 'net';

const app = express();
const server = createServer(app);

const wss = new WebSocketServer({ server, path: '/ws/robot' });
const visionWss = new WebSocketServer({ server, path: '/ws/vision' });

wss.on('connection', (ws) => {
    console.log('[SERVER] Robot connected');
    ws.on('message', (data) => {
        console.log('[SERVER] Robot received:', data.toString());
        ws.send('Echo: ' + data.toString());
    });
    ws.on('close', () => console.log('[SERVER] Robot disconnected'));
});

visionWss.on('connection', (ws) => {
    console.log('[SERVER] Vision connected');
    ws.on('close', () => console.log('[SERVER] Vision disconnected'));
});

app.get('/api/status', (req, res) => res.json({ status: 'ok' }));

server.listen(9997, () => {
    console.log('[SERVER] Listening on http://localhost:9997');
    
    // Raw client test
    setTimeout(() => {
        const client = new net.Socket();
        
        client.connect(9997, '127.0.0.1', () => {
            console.log('[RAW] Connected');
            
            const request = [
                'GET /ws/robot HTTP/1.1',
                'Host: localhost:9997',
                'Upgrade: websocket',
                'Connection: Upgrade',
                'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
                'Sec-WebSocket-Version: 13',
                '',
                ''
            ].join('\r\n');
            
            client.write(request);
        });
        
        let handshakeDone = false;
        client.on('data', (data) => {
            if (!handshakeDone) {
                const response = data.toString();
                console.log('[RAW] Response:', response.substring(0, 100));
                if (response.includes('101 Switching')) {
                    console.log('[RAW] Handshake done');
                    handshakeDone = true;
                    
                    // Send text frame: "Hello"
                    const payload = Buffer.from('Hello');
                    const frame = Buffer.alloc(2 + 4 + payload.length);
                    frame[0] = 0x81;
                    frame[1] = 0x80 | payload.length;
                    frame.writeUInt32BE(0x00000000, 2);
                    payload.copy(frame, 6);
                    
                    setTimeout(() => {
                        client.write(frame);
                        console.log('[RAW] Sent text frame');
                    }, 100);
                }
            } else {
                console.log('[RAW] Data after handshake:', data.length, 'bytes');
                console.log('[RAW] Hex:', data.toString('hex').substring(0, 100));
                
                const firstByte = data[0];
                console.log('[RAW] First byte:', firstByte.toString(2).padStart(8, '0'));
                console.log('[RAW] FIN:', (firstByte & 0x80) !== 0);
                console.log('[RAW] RSV1:', (firstByte & 0x40) !== 0);
                console.log('[RAW] Opcode:', firstByte & 0x0F);
            }
        });
        
        client.on('close', () => {
            console.log('[RAW] Connection closed');
            server.close();
        });
        
        client.on('error', (err) => {
            console.error('[RAW] Error:', err.message);
            server.close();
        });
    }, 100);
});
