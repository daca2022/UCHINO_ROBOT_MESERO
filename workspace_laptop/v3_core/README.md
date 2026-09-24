# Uchino v3 Core

Sistema activo de inteligencia, backend, frontend y orquestacion del robot mesero Uchino.

## Servicios

| Servicio | Puerto | Rol |
|---|---:|---|
| Backend API | 3005 | REST, WebSocket y frontend estatico |
| Frontend dev | 5173 | Desarrollo React/Vite |
| Audio pipeline | 8001 | Wake word, supresion de ruido y SER |
| WhisperLiveKit | 8002 | STT |
| Orchestrator | 8100 | Dialogo, TTS, memoria y acciones |
| Grafana | 3000 | Dashboards |

## Arranque

```bash
cd /home/david/chipi_workspace_pln/v3_core
bash start_robot.sh
```

## Interfaces

- `http://localhost:3005/robot`
- `http://localhost:3005/cocina`
- `http://localhost:3005/admin`
- `http://localhost:3005/test_chipi` queda como ruta legacy de pruebas.

## Arquitectura

- `backend_api/`: Express + WebSocket.
- `frontend_ui/`: React 19 + Vite.
- `pln/`: pipeline de lenguaje natural y pedidos por voz.
- `orchestrator/`: FastAPI sidecar con reglas rapidas, dialogo, memoria, TTS y acciones.
- `audio_pipeline/`: DeepFilterNet3, wake word y SER.
- `tts/`: Kokoro y Piper.
- `memory/` y `memory_db/`: memoria de cliente, PostgreSQL, Redis y ChromaDB.
- `ros2_control/`: puente hacia navegacion y recorridos.
- `rpi5/`: scripts de despliegue en Raspberry Pi 5.

## Modelos activos

- Texto primario: DeepSeek V4 Flash via OpenRouter.
- Fallback texto: Llama 3.1 8B Instruct via OpenRouter.
- Fallback local: Ollama Qwen3.5:9B.
- Vision: Qwen3 VL 8B para descripcion y DeepSeek para refinamiento textual.

Gemini y MiniMax quedan como referencias obsoletas en documentos antiguos o adaptadores legacy, no como arquitectura activa.

## Credenciales

Los valores reales se leen desde:

```text
v3_core/.env
```

No escribir claves en README ni codigo. Ver:

```text
../docs_final/operacion/CREDENCIALES_Y_ACCESOS.md
```

