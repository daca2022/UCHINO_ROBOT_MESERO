# llm_brain

## Propósito
Cerebro de inteligencia artificial del Robot Mesero — orquesta la interacción conversacional con clientes mediante LLMs (DeepSeek V4 Flash primario, Llama 3.1 8B Instruct fallback, Ollama Qwen3.5:9B local terciario), function calling para acciones del robot (pedidos, navegación, emociones), y gestión de historial de conversación. Visión usa cascade Qwen3 VL 8B (descripción) → DeepSeek V4 Flash (refinamiento).

## Archivos clave
- `src/adapters/QwenCloudAdapter.mjs`: Adaptador universal para OpenRouter (DeepSeek V4 Flash primario, Llama 3.1 8B fallback) y Ollama local. Implementa `ILlmProvider` con function declarations para registrar pedidos, confirmar, cancelar, navegar, expresar emociones, mostrar menú, y guardar memoria. Configurado con `max_tokens=200` para respuestas concisas.
- `src/services/LlmOrchestrator.mjs`: Orquestador principal — coordina el ciclo completo audio/texto/imagen → LLM → function calling → respuesta, gestiona historial de conversación y emite eventos de emoción.
- `src/ports/ILlmProvider.mjs`: Interfaz abstracta que define el contrato para cualquier proveedor LLM (initSession, sendAudio, sendText, sendImage, closeSession).
- `src/index.mjs`: Exporta `LlmOrchestrator`, `QwenCloudAdapter`, `MockLlmProvider`.

## Tecnologías
- Node.js (ES modules, `.mjs`)
- OpenRouter API (DeepSeek V4 Flash primario, Llama 3.1 8B Instruct fallback, Qwen3 VL 8B visión)
- Ollama local (Qwen3.5:9B fallback terciario)

## Interacciones
- **Consume**: `memory_db` (para guardar memoria de conversación)
- **Provee a**: `backend_api` (inyectado como servicio en `services.mjs`)
- **Respeta**: `ILlmProvider` para todo proveedor de LLM

## Puertos/Endpoints
- No expone puerto propio. Es una librería consumida por `backend_api`.
