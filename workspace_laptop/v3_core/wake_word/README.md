# wake_word

## Propósito

Detecta la frase de activacion "Oye Uchino" en el stream de audio que llega del ESP32. Usa OpenWakeWord con modelos HuBERT pre-entrenados para identificar la wake word con baja latencia y minimo consumo de recursos. Solo cuando se detecta la wake word, el pipeline de audio activa la supresion de ruido y el STT.

## Tecnologías

- Python 3.12
- OpenWakeWord
- HuBERT (modelos de deteccion)

## Archivos principales

- `detector.py` — Detector de wake word con OpenWakeWord

## Interacciones

- **Recibe**: Stream de audio del ESP32 via audio pipeline
- **Activa**: Supresion de ruido (DeepFilterNet3) y STT (WhisperLiveKit) al detectar "Oye Uchino"
- **Coordina con**: `audio_pipeline/` (integrado en el pipeline), `models/` (modelos HuBERT en `models/hubert/`)
