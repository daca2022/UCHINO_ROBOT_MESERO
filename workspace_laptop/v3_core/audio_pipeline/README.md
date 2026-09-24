# audio_pipeline

## Propósito

Procesa el audio crudo que llega del ESP32 a traves de WebSocket. Aplica deteccion de wake word ("Oye Uchino"), supresion de ruido con DeepFilterNet3, y extraccion de emociones con wav2vec2 (SER). El audio limpio y las etiquetas de emocion se envian al STT (WhisperLiveKit) para transcripcion.

## Tecnologías

- Python 3.12 + asyncio + websockets
- DeepFilterNet3 (supresion de ruido)
- wav2vec2 (Speech Emotion Recognition)
- OpenWakeWord (deteccion de wake word)

## Archivos principales

- `pipeline_manager.py` — Orquestador principal del pipeline de audio
- `noise_suppressor.py` — Modulo de supresion de ruido con DeepFilterNet3
- `ser_branch.py` — Rama de extraccion de emociones (wav2vec2)

## Interacciones

- **Recibe**: Audio binario del ESP32 via WebSocket (`ws://localhost:3005/ws/robot`)
- **Envia**: Audio limpio + emocion a WhisperLiveKit (puerto 8002)
- **Coordina con**: `wake_word/` (deteccion de "Oye Uchino"), `emotion/` (mapeo de emociones), `orchestrator/` (sidecar en :8100)

## Puertos/Endpoints

- **8001** — Proxy del audio pipeline (wake word + DNF3 + SER)
