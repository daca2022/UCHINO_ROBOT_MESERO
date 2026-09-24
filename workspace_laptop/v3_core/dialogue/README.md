# dialogue

## Propósito

Gestiona la maquina de estados conversacional de Uchino usando LangGraph. Define 7 estados de conversacion (saludo, toma de pedido, espera, respuesta, etc.) y maneja las transiciones entre ellos. Se integra con el LLM (DeepSeek V4 Flash via OpenRouter, primario) para generar respuestas contextuales y con el sistema de memoria para recordar interacciones previas.

## Tecnologías

- Python 3.12 + LangGraph
- OpenRouter API (Llama 3.1 8B Instruct, DeepSeek V4 Flash)
- asyncio + websockets

## Archivos principales

- `state_machine.py` — Definicion de la maquina de estados con LangGraph
- `state_handlers.py` — Handlers para cada estado conversacional
- `llm_client.py` — Cliente para comunicacion con el LLM via OpenRouter

## Interacciones

- **Recibe**: Texto transcrito del STT (WhisperLiveKit)
- **Envia**: Respuestas de texto al orchestrator para sintesis TTS
- **Coordina con**: `orchestrator/` (fast rules + dialogo), `memory/` (mem0 + person memory), `emotion/` (emocion actual del usuario)
