# emotion

## Propósito

Analiza y mapea las emociones del usuario a partir de dos fuentes: la voz (via wav2vec2 en el audio pipeline) y el texto (analisis de sentimiento del mensaje transcrito). Combina ambas senales para producir un estado emocional unificado que Uchino usa para adaptar su tono de respuesta y expresion facial en la pantalla.

## Tecnologías

- Python 3.12
- wav2vec2 (Speech Emotion Recognition)
- Analisis de sentimiento por texto (LLM o modelo local)

## Archivos principales

- `emotion_pipeline.py` — Pipeline completo de analisis emocional (voz + texto)
- `emotion_mapper.py` — Mapeo de emociones crudas a estados utilizables por el sistema

## Interacciones

- **Recibe**: Features de emocion del audio pipeline (wav2vec2), texto del dialogo
- **Envia**: Estado emocional unificado al orchestrator y al frontend para expresion facial
- **Coordina con**: `audio_pipeline/` (ser_branch), `dialogue/` (contexto conversacional), `orchestrator/` (decision de respuesta emocional)
