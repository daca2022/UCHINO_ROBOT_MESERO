# turn_taking

## Propósito

Predice cuando el usuario ha terminado de hablar para que Uchino sepa cuando empezar a responder. Analiza patrones de pausa, entonacion y contexto conversacional para determinar los puntos de transicion de turno. Evita que Uchino interrumpa al usuario o espere demasiado antes de responder.

## Tecnologías

- Python 3.12
- Analisis de patrones de audio (pausas, energia)

## Archivos principales

- `turn_predictor.py` — Predictor de turnos conversacionales

## Interacciones

- **Recibe**: Senal de audio del audio pipeline (energia, pausas)
- **Envia**: Senal de "turno terminado" al orchestrator para iniciar respuesta
- **Coordina con**: `audio_pipeline/` (senales de audio), `orchestrator/` (inicio de TTS), `dialogue/` (contexto conversacional)
