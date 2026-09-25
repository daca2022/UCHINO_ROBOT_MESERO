# models

## Propósito

Documenta los modelos que usa el sistema Uchino. Los pesos grandes están
ignorados por Git y se descargan siguiendo [`docs/GUIA_VOZ.md`](../../../docs/GUIA_VOZ.md);
esta carpeta conserva configuraciones y referencias reproducibles.

## Tecnologías

- ONNX Runtime (modelos Piper)
- PyTorch (modelos HuBERT)
- Ollama (Modelfile para Qwen local)

## Archivos principales

- `piper/es_ES-davefx-medium.onnx` — Voz Piper en español, **no incluida**; el JSON de configuración sí está versionado
- `hubert/hubert_state.pt` — Modelo HuBERT para OpenWakeWord, **no incluido**
- `chipi-mesero.Modelfile` — Definicion del modelo Ollama para Qwen3.5:9B

## Interacciones

- **Usado por**: `tts/` (modelo Piper para fallback local), `wake_word/` (modelos HuBERT para deteccion), `llm_brain/` (Ollama para Qwen local)
- **No es codigo ejecutable**: Solo contiene archivos de modelos binarios y configuraciones
