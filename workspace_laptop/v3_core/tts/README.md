# tts

## Propósito

Sintetiza texto a voz para las respuestas de Uchino. Usa Kokoro ONNX como motor primario (bajo consumo de VRAM, ~0.3 GB) y Piper ONNX como fallback local. Incluye soporte para RVC (Retrieval-based Voice Conversion) para personalizacion de voz y un servidor HTTP para solicitudes de sintesis.

## Tecnologías

- Python 3.12
- Kokoro ONNX (TTS primario)
- Piper ONNX (TTS fallback)
- RVC (Retrieval-based Voice Conversion)

## Archivos principales

- `tts_manager.py` — Gestor principal que selecciona motor y genera audio
- `kokoro_tts.py` — Implementacion de TTS con Kokoro ONNX
- `auron_voice.py` — Configuracion de voz personalizada (Auron)

## Interacciones

- **Recibe**: Texto del orchestrator o del backend
- **Envia**: Audio WAV al orchestrator para envio al ESP32
- **Coordina con**: `orchestrator/` (solicitudes de TTS), `gpu_manager/` (verificacion de VRAM antes de cargar Kokoro), `models/` (modelo Piper de fallback)
