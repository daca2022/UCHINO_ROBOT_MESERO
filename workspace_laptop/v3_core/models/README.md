# models

## Propósito

Almacena los archivos de modelos pre-entrenados que usa el sistema Uchino. Incluye modelos de TTS (Piper ONNX para sintesis de voz en espanol), modelos HuBERT para deteccion de wake word (OpenWakeWord), y el Modelfile para Ollama (Qwen3.5:9B como LLM local terciario).

## Tecnologías

- ONNX Runtime (modelos Piper)
- PyTorch (modelos HuBERT)
- Ollama (Modelfile para Qwen local)

## Archivos principales

- `piper/es_ES-davefx-medium.onnx` — Modelo TTS Piper en espanol
- `hubert/hubert_state.pt` — Modelo HuBERT para OpenWakeWord
- `chipi-mesero.Modelfile` — Definicion del modelo Ollama para Qwen3.5:9B

## Interacciones

- **Usado por**: `tts/` (modelo Piper para fallback local), `wake_word/` (modelos HuBERT para deteccion), `llm_brain/` (Ollama para Qwen local)
- **No es codigo ejecutable**: Solo contiene archivos de modelos binarios y configuraciones
