// .env loaded via node --env-file flag (ESM import order fix)
import { createApp } from './index.mjs';

process.on('unhandledRejection', (err) => {
    console.error('[FATAL] Unhandled Rejection:', err?.message || err);
});
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err?.message || err);
});

const PORT = process.env.PORT || 3005;

const { server } = await createApp();
server.listen(PORT, () => {
    console.log(`🚀 Backend API escuchando en http://localhost:${PORT}`);
    console.log(`   API: http://localhost:${PORT}/api/status`);
    console.log(`   WS:  ws://localhost:${PORT}/ws/robot`);
    console.log(`   WS lab: ws://localhost:${PORT}/ws/esp32-lab`);
    console.log(`   TCP lab: tcp://localhost:${process.env.AUDIO_LAB_TCP_PORT || 3011}`);
});
