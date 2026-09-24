import net from 'net';

const client = new net.Socket();

client.connect(3003, '127.0.0.1', () => {
    console.log('[RAW] Connected to server');
    
    // Send WebSocket upgrade request
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    const request = [
        'GET /ws/robot HTTP/1.1',
        'Host: localhost:3003',
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
        '',
        ''
    ].join('\r\n');
    
    client.write(request);
});

client.on('data', (data) => {
    console.log('[RAW] Received:', data.length, 'bytes');
    console.log('[RAW] Data:', data.toString('hex').substring(0, 200));
    
    // Check if it's the HTTP response
    if (data.toString().startsWith('HTTP/1.1 101')) {
        console.log('[RAW] WebSocket handshake successful');
        
        // Send a text frame with "Hello"
        // FIN=1, opcode=1 (text), mask=1
        const payload = Buffer.from('Hello');
        const frame = Buffer.alloc(2 + 4 + payload.length);
        frame[0] = 0x81; // FIN=1, opcode=text
        frame[1] = 0x80 | payload.length; // MASK=1, length
        // Masking key
        frame.writeUInt32BE(0x00000000, 2);
        // XOR payload with mask (all zeros, so payload stays the same)
        payload.copy(frame, 6);
        
        setTimeout(() => {
            client.write(frame);
            console.log('[RAW] Sent text frame');
        }, 100);
        
        setTimeout(() => {
            client.end();
            console.log('[RAW] Closed connection');
        }, 500);
    } else {
        // Parse WebSocket frame
        const firstByte = data[0];
        const fin = (firstByte & 0x80) !== 0;
        const rsv1 = (firstByte & 0x40) !== 0;
        const rsv2 = (firstByte & 0x20) !== 0;
        const rsv3 = (firstByte & 0x10) !== 0;
        const opcode = firstByte & 0x0F;
        
        console.log('[RAW] Frame info:');
        console.log('  FIN:', fin);
        console.log('  RSV1:', rsv1);
        console.log('  RSV2:', rsv2);
        console.log('  RSV3:', rsv3);
        console.log('  Opcode:', opcode);
    }
});

client.on('close', () => {
    console.log('[RAW] Connection closed');
});

client.on('error', (err) => {
    console.error('[RAW] Error:', err.message);
});
