import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3005',
      '/ws': { target: 'ws://localhost:3005', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        robot: resolve(__dirname, 'robot.html'),
        cocina: resolve(__dirname, 'cocina.html'),
        admin: resolve(__dirname, 'admin.html'),
        'audio-lab': resolve(__dirname, 'audio-lab.html'),
      },
    },
  },
});
