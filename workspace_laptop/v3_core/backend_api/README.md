# MODULO: backend_api

## Propósito
Servidor HTTP/WebSocket principal del Robot Mesero que expone la API REST, gestiona conexiones en tiempo real, y orquesta todos los servicios del sistema (LLM, memoria, ROS2, TTS/ASR) mediante inyección de dependencias.

## Archivos clave
- `src/server.mjs`: Punto de entrada — crea la app y escucha en el puerto configurado (default 3005, fallback 3003).
- `src/config/services.mjs`: Fábrica de servicios — inicializa SQLite, PostgreSQL, Redis, ChromaDB, y wirea todos los servicios del sistema en un único objeto inyectable.
- `src/application/PiperTTS.mjs`: Servicio de síntesis de voz offline con Piper TTS (fallback).
- `src/application/KokoroTTS.mjs`: Servicio de síntesis de voz primario con Kokoro ONNX (GPU).
- **`WhisperLiveKit` (Servidor Externo):** El motor STT (Speech-to-Text) ultra rápido basado en SimulStreaming. Acepta los bytes PCM crudos del ESP32 mediante WebSocket en el **puerto 8002**.
- `src/application/WhisperASR.mjs`: Wrapper que actúa como **Proxy WebSocket** conectando el puerto 3005 con el puerto 8001 (Audio Pipeline) en tiempo real.
- `src/index.mjs`: Exporta `createApp()` — configura Express, rutas, WebSocket, y middleware.

## Cómo extender
Agregar nuevos servicios en `src/config/services.mjs` e inyectarlos en los handlers de rutas o WebSocket. Para nuevas rutas, crear archivos en `src/routes/` y registrarlos en `src/index.mjs`.

## Dependencias
- npm: express, ws, dotenv, pg (PostgreSQL), redis, chromadb, node:sqlite
- Externos: Kokoro TTS (ONNX, GPU), Piper TTS binario, WhisperLiveKit, PostgreSQL, Redis, ChromaDB
- Otros módulos: llm_brain, memory_db, ros2_control
