# tts

## Propósito

Sintetiza texto a voz para las respuestas de Uchino. Usa Kokoro como motor
local primario y conserva Piper como alternativa. Los paquetes Python, los
pesos ONNX y los entornos de reproducción no se incluyen en el clon público;
la instalación está en [`docs/GUIA_VOZ.md`](../../../docs/GUIA_VOZ.md).

## Tecnologías

- Python 3.12
- Kokoro ONNX (TTS primario)
- Piper ONNX (TTS fallback)
- RVC (Retrieval-based Voice Conversion)

## Archivos principales

- `tts_manager.py` — Gestor principal que selecciona motor y genera audio
- `kokoro_tts.py` — Implementacion de TTS con Kokoro ONNX
- `auron_voice.py` — Configuración de voz personalizada (Auron)

## Interacciones

- **Recibe**: Texto del orchestrator o del backend
- **Envia**: Audio WAV al orchestrator para envio al ESP32
- **Coordina con**: `orchestrator/` (solicitudes de TTS), `gpu_manager/` (verificacion de VRAM antes de cargar Kokoro), `models/` (modelo Piper de fallback)
