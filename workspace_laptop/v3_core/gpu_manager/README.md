# gpu_manager

## Propósito

Monitorea y gestiona el uso de la GPU NVIDIA RTX 5000. Proporciona metricas de VRAM, utilizacion de GPU y temperatura para que el sistema pueda tomar decisiones sobre que modelos cargar y cuando liberar memoria. Esencial para coordinar el uso compartido de GPU entre Kokoro TTS, WhisperLiveKit, y otros modelos.

## Tecnologías

- Python 3.12
- pynvml (NVIDIA Management Library)

## Archivos principales

- `gpu_monitor.py` — Monitor de GPU con metricas de VRAM, utilizacion y temperatura

## Interacciones

- **Consulta**: Estado de la GPU NVIDIA via pynvml
- **Provee datos a**: `orchestrator/` (decisiones de carga de modelos), `tts/` (verificacion de VRAM antes de cargar Kokoro), `gpu_manager/` (monitoreo continuo)
