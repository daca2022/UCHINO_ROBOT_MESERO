import net from 'net';

const listenPort = 3014;
const targetPort = 3011;

const server = net.createServer((clientSocket) => {
    console.log(`[Proxy] Connection from ${clientSocket.remoteAddress}`);
    
    const targetSocket = new net.Socket();
    targetSocket.connect(targetPort, '127.0.0.1', () => {
        console.log(`[Proxy] Connected to target on ${targetPort}`);
    });

    clientSocket.on('data', (data) => {
        console.log(`[Proxy] Client -> Target: ${data.length} bytes (hex: ${data.toString('hex').substring(0, 40)}...)`);
        targetSocket.write(data);
    });

    targetSocket.on('data', (data) => {
        console.log(`[Proxy] Target -> Client: ${data.length} bytes`);
        clientSocket.write(data);
    });

    clientSocket.on('close', (hadError) => {
        console.log(`[Proxy] Client closed. Error: ${hadError}`);
        targetSocket.destroy();
    });

    targetSocket.on('close', (hadError) => {
        console.log(`[Proxy] Target closed. Error: ${hadError}`);
        clientSocket.destroy();
    });

    clientSocket.on('error', (err) => console.log(`[Proxy] Client error: ${err.message}`));
    targetSocket.on('error', (err) => console.log(`[Proxy] Target error: ${err.message}`));
});

server.listen(listenPort, () => {
    console.log(`[Proxy] Listening on ${listenPort}`);
});
