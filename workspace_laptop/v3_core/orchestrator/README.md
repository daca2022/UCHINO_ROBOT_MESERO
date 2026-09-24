# orchestrator

## Propósito

El corazon del sistema de voz de Uchino. El MasterOrchestrator (FastAPI en puerto 8100) coordina todo el pipeline: aplica fast rules para respuestas inmediatas (saludos, emergencias), gestiona el dialogo con LangGraph, invoca TTS (Kokoro/Piper), accede a la memoria, y se comunica con ROS2 para movimientos del robot. Es la ruta primaria del pipeline de voz, con fallback al backend Node.js.

## Tecnologías

- Python 3.12 + FastAPI + uvicorn
- LangGraph (dialogo)
- ROS2 (via rclpy)
- WebSocket cliente (comunicacion con backend)

## Archivos principales

- `master_orchestrator.py` — Orquestador principal con fast rules + dialogo + TTS + memoria
- `fast_rules.py` — Reglas de respuesta rapida (wake word, emergencias, comandos simples)
- `server.py` — Servidor FastAPI (puerto 8100)

## Interacciones

- **Recibe**: Texto + emocion del audio pipeline
- **Envia**: Audio TTS (WAV) al backend via WebSocket para envio al ESP32
- **Coordina con**: `dialogue/` (maquina de estados), `tts/` (sintesis de voz), `memory/` (recuperacion de contexto), `ros2_control/` (movimientos del robot), `vision/` (analisis de imagenes), `emotion/` (respuesta emocional)

## Puertos/Endpoints

- **8100** — Servidor FastAPI del orchestrator (http://localhost:8100)
