# 🤖 v3 Core — Servidor IA del Robot Mesero (v3)

**Generado:** 2026-07-06
**Versión:** 3.2.5

## DESCRIPCIÓN GENERAL

Núcleo de inteligencia artificial y orquestación del Robot Mesero UTEC — **versión 3**. Combina Node.js (Express + WebSocket) para el servidor principal y Python (asyncio, LangGraph) para el pipeline de IA. Es la **capa cerebral** del robot: recibe audio del ESP32 o del browser, aplica wake word + noise suppression, transcribe con WhisperLiveKit, razona con DeepSeek V4 Flash (vía OpenRouter, primario) con fallback a Llama 3.1 8B Instruct (OpenRouter, 0.65s latencia, roleplay peruano natural) y Ollama Qwen3.5:9B local, sintetiza voz con Piper/Kokoro, analiza imágenes con cascade Qwen3 VL 8B (descripción) → DeepSeek V4 Flash (refinamiento), y coordina ROS2 + visión + memoria.

> **LLM bridge:** Todos los proveedores (DeepSeek V4 Flash, Llama 3.1 8B, Ollama) se llaman a través de `QwenCloudAdapter` (adaptador universal compatible con API DashScope/OpenRouter). El adaptador `QwenAdapter` original solo se usa para Ollama local. `GeminiAdapter` y `MiniMax M3` están obsoletos y NO se usan. Vision usa cascade Qwen3 VL 8B (descripción) → DeepSeek V4 Flash (refinamiento).

> **Cambio principal v3:** Migración completa desde Node-RED (v2) hacia una arquitectura híbrida Node.js/Python. El pipeline de voz ahora incluye wake word (OpenWakeWord), supresión de ruido (DeepFilterNet3), SER (reconocimiento de emociones por voz), TTS dual (Kokoro + Piper), y un orquestador maestro con máquina de estados LangGraph de 7 estados conversacionales.

> ⚠️ **MiniMax M3 eliminado completamente.** Nunca usar `minimax/minimax-m3` como LLM. El sistema usa **DeepSeek V4 Flash** (vía OpenRouter, primario para texto, 2.7s, sin reasoning tokens), **Llama 3.1 8B Instruct** (fallback, 0.65s latencia, roleplay peruano natural), y **Ollama Qwen3.5:9B** (fallback local). Para visión: cascade **Qwen3 VL 8B** (descripción) → **DeepSeek V4 Flash** (refinamiento). La memoria (embeddings) usa **sentence-transformers local** — sin APIs externas de embedding.

> **Reglas globales del workspace:** Ver `AGENTS.md` (raíz) para 🚫 Hard Rules, 🔒 Security Rules, 🌿 Git Workflow y 🔄 Maintenance Rule.

---

## ESTRUCTURA

```
v3_core/
├── backend_api/               # [Node.js] Servidor Express + WebSocket (:3005)
│   ├── src/
│   │   ├── server.mjs         # Entry point (usa PORT env, fallback 3005)
│   │   ├── index.mjs          # createApp() — Express + WS + rutas + system prompt
│   │   ├── config/
│   │   │   └── services.mjs   # DI container (llm, memory, ros2, asr, tts)
│   │   ├── application/
│   │   │   ├── PiperTTS.mjs   # TTS: texto → voz (Piper ONNX subprocess)
│   │   │   ├── WhisperASR.mjs # Proxy WS: backend → WhisperLiveKit (8001)
│   │   │   └── CocinaService.mjs
│   │   ├── domain/
│   │   │   ├── Cliente.mjs    # Entidad cliente
│   │   │   └── Pedido.mjs     # Entidad pedido
│   │   └── interfaces/
│   │       ├── http/          # Rutas REST
│   │       ├── ws/            # Handlers WebSocket
│   │       └── llmBridgeRouter.mjs
│   └── tests/
│
├── frontend_ui/               # [React 19] Frontends Vite + Tailwind (Neon)
│   ├── src/
│   │   ├── main.jsx           # Entry point original (respaldo)
│   │   ├── main-robot.jsx     # Entry point — RobotScreen (build separado)
│   │   ├── main-cocina.jsx    # Entry point — CocinaKDS (build separado)
│   │   ├── main-admin.jsx     # Entry point — AdminDashboard (build separado)
│   │   ├── RobotScreen.jsx    # Pantalla táctil 7" del robot
│   │   ├── CocinaKDS.jsx      # KDS — pedidos en tiempo real
│   │   ├── AdminDashboard.jsx # Dashboard admin + métricas
│   │   ├── hooks.js           # useWebSocket, useApi
│   │   └── index.css          # Tailwind theme neon cyberpunk
│   ├── dist/                  # Build multi-page: robot.html, cocina.html, admin.html
│   ├── robot.html             # Entry HTML para página del robot
│   ├── cocina.html            # Entry HTML para página de cocina
│   ├── admin.html             # Entry HTML para página de admin
│   └── vite.config.js         # rollupOptions.input: 3 entry points
│
├── llm_brain/                 # [Node.js] Cerebro LLM
│   ├── src/
│   │   ├── index.mjs          # Exporta LlmOrchestrator, adapters
│   │   ├── ports/
│   │   │   └── ILlmProvider.mjs # Interfaz abstracta LLM
│   │   ├── adapters/
│   │   │   ├── GeminiAdapter.mjs       # ⚠️ OBSOLETO — Gemini eliminado
│   │   │   ├── MockLlmProvider.mjs     # Fallback offline
│   │   │   ├── QwenAdapter.mjs         # Qwen3.5:9B (Ollama local, terciario)
│   │   │   └── QwenCloudAdapter.mjs    # Adaptador universal OpenRouter (DeepSeek V4 Flash primario, Llama 3.1 8B fallback)
│   │   └── services/
│   │       └── LlmOrchestrator.mjs # Ciclo: audio/texto/imagen → LLM → función
│   └── tests/
│
├── memory_db/                 # [Node.js] Persistencia multicapa
│   ├── src/
│   │   └── services/
│   │       ├── MemoryService.mjs    # Fachada unificada
│   │       ├── postgresService.mjs  # PostgreSQL (analytics)
│   │       ├── redisService.mjs     # Redis (caché)
│   │       └── chromaService.mjs    # ChromaDB (memoria vectorial)
│   └── migrations/
│
├── ros2_control/              # [Node.js] Puente ROS2
│   ├── src/
│   │   └── services/
│   │       ├── RecorridoService.mjs    # Recorridos cocina→mesa→base
│   │       └── NavigationService.mjs   # Navegación (Nav2)
│   └── tests/
│
├── audio_pipeline/            # [Python] Pipeline de audio
│   ├── pipeline_manager.py    # Proxy WS entrada: ESP32 → wake word → DNF3 → SER → salida
│   ├── noise_suppressor.py    # DeepFilterNet3
│   └── ser_branch.py          # wav2vec2 → emoción cada 3 segundos
│
├── dialogue/                  # [Python] LangGraph state machine
│   ├── state_machine.py       # Máquina de estados: 7 estados conversacionales
│   ├── graph_config.py        # Configuración del grafo LangGraph
│   ├── node_intent.py         # Nodo: clasificación de intención
│   ├── node_context.py        # Nodo: gestión de contexto
│   ├── node_llm.py            # Nodo: llamada a LLM
│   ├── node_tool_exec.py      # Nodo: ejecución de tools
│   ├── node_tts.py            # Nodo: síntesis de voz
│   ├── checkpoint_manager.py  # Checkpoint Redis con TTL 1h
│   ├── llm_client.py          # Cliente HTTP al bridge LLM de Node.js (provider agnóstico)
│   └── qa_test.py
│
├── emotion/                   # [Python] Detección de emociones de Uchino
│   ├── emotion_pipeline.py    # Fusión SER + texto → emoción final de Uchino
│   └── emotion_mapper.py      # Mapeo SER→Uchino, texto→Uchino, meta de emociones
│
├── gpu_manager/               # [Python] Gestión de VRAM (RTX 5000 — 16 GB)
│   └── gpu_monitor.py         # Monitoreo nvidia-smi, prioridades, evicción automática
│
├── memory/                    # [Python] Memoria persistente (mem0 + ChromaDB)
│   ├── mem0_setup.py          # Configuración mem0 con ChromaDB
│   ├── person_memory.py       # Memoria por persona (preferencias, historial)
│   ├── semantic_extractor.py  # Extracción semántica de conversaciones
│   ├── handler_router.py      # Ruteo de handlers de función
│   └── function_handlers.py   # Handlers específicos de memoria
│
├── orchestrator/              # [Python] Orquestador maestro
│   ├── server.py              # FastAPI sidecar (:8100) — POST /orchestrate, /health, /
│   ├── master_orchestrator.py # Sistema 1 (fast rules) + Sistema 2 (LLM) + ejecución
│   ├── fast_rules.py          # Reglas rápidas (respuestas inmediatas sin LLM)
│   ├── ros2_bridge.py         # Puente HTTP→ROS2 para comandos de navegación
│   └── vision_client.py       # Cliente HTTP para captura de cámara
│
├── tts/                       # [Python] Síntesis de voz
│   ├── tts_manager.py         # Kokoro (primary) + Piper (fallback) con auto-switch
│   └── kokoro_tts.py          # Kokoro TTS: control emocional, 0.3 GB VRAM
│
├── turn_taking/               # [Python] Predictor de turnos conversacionales
│   └── turn_predictor.py      # Reglas lingüísticas: silencios, puntuación, español
│
├── vision/                    # [Node.js + Python] Visión por cámara
│   ├── vision_manager.mjs     # Backend handler: verMesa, verCliente, verLugar
│   ├── vision_capture_node.py # Captura RGB Logitech Brio → HTTP JPEG
│   └── execution_checker.py   # Verificación de ejecución vía visión
│
├── wake_word/                 # [Python] Detector de wake word
│   └── detector.py            # OpenWakeWord: display="Oye Uchino" → modelo="hey_jarvis_v0.1" (per-connection configurable via ?no_wake_word=1)
│
├── WhisperLiveKit/            # [STT] Motor ASR externo (git clone)
│   └── (SimulStreaming, faster-whisper large-v3-turbo, diarización)
│
├── docker/
│   └── docker-compose.infra.yml # PostgreSQL, Redis, ChromaDB, InfluxDB, Grafana, Mosquitto
│
├── grafana/                   # Dashboards y provisioning
│   ├── dashboards/
│   └── provisioning/
│
├── models/                    # Modelos IA
│   ├── piper/                 # Modelos ONNX para Piper TTS (es_ES-davefx-medium)
│   └── chipi-mesero.Modelfile # Ollama Modelfile para Qwen3.5:9B
│
├── data/                      # Datos runtime
│   ├── robot_mesero.db        # SQLite local
│   └── *.json                 # Memorias de agentes (OpenClaw, Uchino)
│
├── scripts/                   # Scripts Bash/Python auxiliares
│   ├── download_qwen3.sh      # Descarga modelo Qwen3.5 local
│   ├── memory_db/init_db.sql  # Inicialización base de datos
│   ├── local_audio_sink.py    # Receptor de audio local
│   ├── setup_piper_model.sh   # Descarga modelo Piper TTS
│   ├── setup_rpi5.sh          # Configuración Raspberry Pi 5
│   ├── start_uchino.sh        # Inicia servidor Uchino vLLM
│   ├── stop_uchino.sh         # Detiene servidor Uchino vLLM
│   └── stt_service.py         # Servicio STT auxiliar
│
├── docs/                      # Documentación interna
│   ├── GUIA_DESPLIEGUE_FASE_C.md
│   ├── API_KEYS_SETUP.md
│   ├── REFACTOR_V3_BITACORA.md
│   ├── DEMO_AUDIO.md
│   └── (agentes/, arquitectura/, demos/, diagramas/, ia-nlp/)
│
├── tests/                     # Tests de integración Python
│   ├── conftest.py
│   ├── test_e2e_qwen_pipeline.py
│   └── integration/
│       ├── conftest.py
│       ├── test_full_pipeline.py
│       └── test_health_check.py
│
├── rpi5/                      # Scripts Raspberry Pi 5
│   ├── start_ros2.sh
│   ├── chipi-kiosk.service    # Kiosk mode para frontend
│   └── kiosk_start.sh
│
├── wav2vec2_checkpoints/      # Checkpoints para SER (wav2vec2)
├── .sisyphus/                 # Planes y notas del agente Sisyphus
│   └── notepads/
│
├── start_robot.sh             # Script de inicio global v3 (Docker + backend + sidecar)
├── stop_robot.sh              # Script de parada global v3 (mata todos los procesos)
├── start_pipeline.sh          # Pipeline de audio (wake word + DNF3 + SER)
├── start_stt.sh               # Solo WhisperLiveKit STT
├── start_all.sh               # Alternativa: Docker + server + scripts legacy
├── iniciar_chipi_voz.sh       # Inicio rápido de voz
├── ver_conversacion.sh        # Visualizar conversación en tiempo real
├── .env                       # Variables de entorno (NO COMMITEAR)
└── AGENTS.md                  # Este archivo
```

---

## VOICE PIPELINE (Flujo de Voz Completo)

```
ESP32 (INMP441 mic) ──RAW PCM──► audio_pipeline (:8001)
                                       │
                              ┌────────┴────────┐        ┌─────────────┐
                              │ Wake Word        │        │ Turn Taking │
                              │ (OpenWakeWord)   │◄───────│ Predictor   │
                              │ "Uchino"/"Oye Uchino" │   │ (silencios) │
                              └────────┬────────┘        └─────────────┘
                                       │ activado
                              ┌────────┴────────┐
                              │ Noise Suppressor│
                              │ (DeepFilterNet3)│
                              └────────┬────────┘
                                       │ PCM limpio (16 kHz)
                              ┌────────┴────────┐
                              │ SER Branch      │
                              │ (wav2vec2)      │
                              │ emoción cada 3s │
                              └────────┬────────┘
                                       │ PCM + emoción
                              ┌────────┴────────┐
                              │ WhisperLiveKit  │
                              │ (:8002)         │
                              │ faster-whisper  │
                              │ large-v3-turbo  │
                              └────────┬────────┘
                                       │ texto transcrito
                              ┌──────────────────────┐
                              │ Orchestrator (:8100)  │
                              │ Fast rules (System 1) │
                              │ Dialogue (LangGraph)  │
                              │ Memory (Mem0 + Person)│
                              │ TTS (Kokoro)          │
                              └──────────┬───────────┘
                                         │ ruta primaria
                              ┌──────────┴───────────┐
                              │ Backend API (:3005)   │
                              │ LLM bridge (Qwen/     │
                              │  DeepSeek via OpenRouter)│
                              │ PiperTTS (fallback)   │
                              │ Vision (RGB Brio)     │
                              │ Function Calling      │
                              │ Memory (mem0+Chroma)  │
                              └──────────┬───────────┘
                                         │ WAV binario
ESP32 (MAX98357A spk) ◄──WS binario───────┘
                              ▲
                              │
                    Orchestrator (:8100) responde
                    directo cuando fast rule coincide
                    (wake word, emergencia)
```

**Estados del diálogo (LangGraph):**
```
idle → greeting → taking_order → confirming → confirming_order → delivering → farewell
```
Cada transición es gatillada por: intención del LLM, wake word, input táctil UI, o timeout.

**Estados determinísticos del pedido continuo en `/robot` (Fase 1):**
```
idle → listening → processing → awaiting_confirmation → confirmed → completed
```
Voz y tableta comparten `session_id`, `active_order_id` y el mismo draft a través de las rutas `/api/asr`. Las mesas se representan como `M1` … `M12`; el backend calcula precios y total desde el menú real, emite `nuevo_pedido` una sola vez al confirmar y conserva el pedido confirmado al cerrar la conversación.

---

## MODOS DE EJECUCIÓN

### Modo v3 Completo (Docker + Backend)
```bash
cd ~/chipi_workspace_pln/v3_core && bash start_robot.sh
```
Levanta: Docker (PostgreSQL, Redis, ChromaDB, InfluxDB, Grafana) + Backend API v3 (:3005) + Orchestrator sidecar (:8100).

### Modo v3 Solo Pipeline de Voz
```bash
# Terminal 1: Audio pipeline (wake word + DeepFilterNet3 + SER proxy)
cd v3_core && bash start_pipeline.sh         # Puerto 8001

# Terminal 2: WhisperLiveKit STT
cd v3_core && bash start_stt.sh              # Puerto 8002

# Terminal 3: Orchestrator sidecar (FastAPI — fast rules + diálogo + TTS + memoria)
cd v3_core && python3 -m uvicorn orchestrator.server:app --host 127.0.0.1 --port 8100

# Terminal 4: Backend API
cd v3_core/backend_api && node src/server.mjs  # Puerto 3005 (default 3005 si no hay .env)
```

**Verificar:**
```bash
curl http://localhost:3005/api/status
# → {"status":"ok","version":"3.1.0",...}
```

**URLs:**
| URL | Descripción |
|-----|-------------|
| `http://localhost:3005/robot` | Pantalla táctil del robot (7") |
| `http://localhost:3005/cocina` | KDS de cocina — pedidos en tiempo real |
| `http://localhost:3005/admin` | Dashboard admin + métricas |
| `http://localhost:3000` | Grafana — dashboards de monitoreo |

---

## DÓNDE BUSCAR

| Tarea | Ubicación | Notas |
|-------|-----------|-------|
| Servidor principal v3 | `backend_api/src/server.mjs` | Express + WebSocket puerto 3005 (fallback 3005) |
| Voice Pipeline proxy | `audio_pipeline/pipeline_manager.py` | WS en puerto 8001 |
| STT (Whisper) | `WhisperLiveKit/` | faster-whisper large-v3-turbo, puerto 8002 |
| Wake Word | `wake_word/detector.py` | OpenWakeWord "Uchino" / "Oye Uchino" |
| Noise Suppressor | `audio_pipeline/noise_suppressor.py` | DeepFilterNet3 |
| SER (emociones voz) | `audio_pipeline/ser_branch.py` | wav2vec2 |
| TTS primario | `tts/kokoro_tts.py` | Kokoro con control emocional |
| TTS fallback | `backend_api/src/application/PiperTTS.mjs` | Piper ONNX local |
| TTS manager (Python) | `tts/tts_manager.py` | Kokoro + Piper auto-switch |
| IA conversacional (primario) | `llm_brain/src/adapters/QwenCloudAdapter.mjs` | DeepSeek V4 Flash via OpenRouter (`deepseek/deepseek-v4-flash`) |
| IA conversacional (fallback) | `llm_brain/src/adapters/QwenCloudAdapter.mjs` | Llama 3.1 8B Instruct via OpenRouter (`meta-llama/llama-3.1-8b-instruct`) — 0.65s latencia |
| IA conversacional (terciario) | `llm_brain/src/adapters/QwenAdapter.mjs` | Qwen3.5:9B via Ollama local (`qwen3.5:9b`) |
| IA conversacional (visión) | `llm_brain/src/adapters/QwenCloudAdapter.mjs` | Cascade: Qwen3 VL 8B (`qwen/qwen3-vl-8b-instruct`) describe → DeepSeek V4 Flash refina |
| IA conversacional | `llm_brain/src/adapters/GeminiAdapter.mjs` | ⚠️ OBSOLETO — Gemini eliminado del proyecto |
| Config proveedores LLM | `llm_brain/src/config/providers.mjs` | Crea 3 providers: DeepSeek V4 Flash (primary), Llama 3.1 8B (fallback), Ollama Qwen3.5 (terciario) |
| Export público LLM | `llm_brain/src/index.mjs` | ⚠️ No exporta QwenCloudAdapter — falta actualizar |
| Orquestador LLM | `llm_brain/src/services/LlmOrchestrator.mjs` | Ciclo audio/texto/imagen → LLM → función |
| Diálogo LangGraph | `dialogue/state_machine.py` | 7 estados conversacionales |
| Memoria Node.js | `memory_db/src/services/MemoryService.mjs` | SQLite + Postgres + Redis + Chroma |
| Memoria Python | `memory/person_memory.py` | mem0 + ChromaDB + person memory |
| Sidecar API (FastAPI) | `orchestrator/server.py` | Entrypoint FastAPI :8100 — /orchestrate, /health, / |
| Orquestador maestro | `orchestrator/master_orchestrator.py` | Sistema 1 (fast rules) + Sistema 2 (diálogo) + memoria + TTS |
| Chat API (texto → TTS) | `backend_api/src/index.mjs` | `POST /api/chat` — texto → LLM → respuesta → TTS → WAV base64 |
| Página de prueba | `frontend_ui/public/test_chipi.html` | `http://localhost:3005/test_chipi` — chat multi-turno con audio |
| Fast rules | `orchestrator/fast_rules.py` | Respuestas inmediatas sin LLM |
| Visión (captura) | `vision/vision_capture_node.py` | Logitech Brio RGB → HTTP JPEG |
| Visión (análisis) | `vision/vision_manager.mjs` | Qwen3 VL 8B describe → DeepSeek V4 Flash refina, vía OpenRouter |
| | | No usa API directa de Google |
| Turn taking | `turn_taking/turn_predictor.py` | Predictor de fin de turno (español) |
| Emociones | `emotion/emotion_pipeline.py` | Fusión SER + texto → emoción Uchino |
| GPU Manager | `gpu_manager/gpu_monitor.py` | VRAM budget RTX 5000 |
| Frontend robot | `frontend_ui/src/RobotScreen.jsx` | React 19 + Tailwind neon |
| Frontend cocina | `frontend_ui/src/CocinaKDS.jsx` | Kitchen Display System |
| Frontend admin | `frontend_ui/src/AdminDashboard.jsx` + `frontend_ui/src/admin/panels/` | Autenticacion JWT con `ADMIN_PASSWORD` o `GF_SECURITY_ADMIN_PASSWORD`, personalidad, menu, pedidos, metricas LLM reales y estado robot honesto si RPi5 no esta conectada. Resolucion RPi5: 800x480 (kiosk_start.sh) |
| ROS2 bridge (Python) | `orchestrator/ros2_bridge.py` | HTTP → ROS2 |
| ROS2 control (Node) | `ros2_control/src/services/RecorridoService.mjs` | Recorridos cocina→mesa→base |
| Firmware ESP32 | `esp32/src/main.cpp` | I2S + WS binario + AudioCompass |
| Docker Compose | `docker/docker-compose.infra.yml` | Infra v3 |
| Arranque v3 | `start_robot.sh` | Un solo comando para todo |

---

## UI, COCINA Y ADMIN — FASE 2

- `/robot` conserva el draft unificado de Fase 1 y usa una franja de resumen con mesa, productos, cantidades, total y estado; el espacio queda reservado para el selector de mesa y el CTA de voz.
- `/cocina` lee pedidos reales desde `/api/cocina/cola` y eventos de `/ws/ui`, mantiene preparar/listo y añade reloj, fecha/hora completa y orden por antigüedad, fecha reciente, mesa o estado.
- `/admin/pedidos` ofrece orden/filtros y el endpoint protegido `DELETE /api/admin/pedidos/:id`, que aplica un borrado atómico y solo permite `draft`; confirmados y entregados se muestran como historial protegido.
- `/admin/personalidad` conserva la configuración PostgreSQL y hot-reload, con error claro y reintento de carga o guardado cuando el backend cae.
- Overview calcula productos más solicitados desde `/api/pedidos` y recibe el estado real por `/ws/ui` (`idle`, `listening`, `processing`, `responding`, `navigating`), sin latencia mock.
- `start_robot.sh` y `scripts/iniciar_chipi.sh` son idempotentes para backend, sidecar, Pipeline y Whisper; el launcher granular aborta ante un backend insalubre. En la verificación del 2026-07-12 quedaron activos `:3005`, `:3500`, `:8001`, `:8002`, `:8100`, PostgreSQL, Redis y WebSocket; InfluxDB mantiene un timeout preexistente.

## MONITOR ROS 2 Y ENTREGA SIMULADA — FASE 3

- `backend_api/src/application/Ros2DeliverySimulator.mjs` es un simulador aislado y determinístico para pedidos `ready`. La arquitectura actual no tiene un publicador ROS 2 físico activo; todos los eventos de esta fase se marcan `simulated` y no se crea una conexión ficticia.
- Admin expone la pestaña `ROS 2 / Flujo` y las rutas protegidas `/api/admin/ros2/*`; el panel muestra catálogo de tópicos, payload JSON, timeline, estado de publicación, origen y controles manuales por etapa.
- El simulador publica `/uchino/order/confirmed`, `/uchino/navigation/goal`, `/uchino/navigation/status`, `/uchino/arms/command`, `/uchino/face/expression`, `/uchino/speech/text` y `/uchino/delivery/status` con `topic`, `message_type`, `timestamp`, `payload`, `publication_state` y `origin`.
- El comando de brazos conserva dos brazos y dos grados de libertad por brazo con posiciones configurables. Solo `finalizar` actualiza un pedido `ready` a `delivered`; `cancelar` deja el pedido sin cambios.
- La recogida registra una espera simulada de 10 segundos desde `picking_up`, pero el avance es manual para la demostración.
- Las mutaciones administrativas exigen `order_id` y `simulation_id` activos; la finalización es idempotente y no duplica la escritura `ready → delivered`.
- Los fallos de notificación UI y de publicación asíncrona no dejan la FSM desincronizada ni generan rechazos no manejados.
- La instancia observa los eventos existentes de pedido y notifica `ros2_event` mediante `/ws/ui`, sin modificar el flujo de confirmación, la preparación de cocina, `RecorridoService` ni el esquema de PostgreSQL.
- `Ros2DeliveryPanel` reutiliza el `/ws/ui` del Dashboard para refresco inmediato y mantiene polling de 2 segundos como respaldo; no abre un canal ROS 2 adicional.
- Verificación local del 2026-07-16: tests dirigidos del simulador `10/10`, build frontend exitoso, servicios principales saludables y QA de navegador sin overflow en `800x480` y `375x667`. La integración productiva con ROS 2/RecorridoService queda pendiente de un bridge real disponible.

## ROBUSTEZ CONVERSACIONAL Y MODOS DE ATENCIÓN — FASE 4

- `backend_api/src/application/IntentClassifier.mjs` se ejecuta antes del LLM para modos de atención, consulta, cantidades, incremento, eliminación, reemplazo, confirmación, rechazo, cancelación, mesa y finalización. Las ambigüedades quedan sin mutación y las aclaraciones consecutivas no se repiten indefinidamente.
- `OrderSessionManager` es la fuente de sesión para `session_id`, `active_order_id`, mesa normalizada `M1`–`M12`, `interaction_mode`, draft, estado y referencias de contexto. `getAllSessions()` expone el draft para hidratar `/robot`; `turn_id` explícito permite replay idempotente de la respuesta.
- `/api/asr/process` conserva el contrato Fase 1 para voz/tableta, valida el draft contra el menú vigente al confirmar, mantiene la orden confirmada al completar y permite suprimir TTS solo para llamadas internas que ya reproducen audio.
- El audio binario de `/ws/robot` comparte el flujo determinístico para intenciones críticas cuando tiene mesa, puede recibir `sessionId`/`mesa` por query y marca `voiceSessionClosed` después de confirmar/completar. El sidecar y el LLM siguen atendiendo conversación social y fallback no crítico.
- `WaiterAssistanceService` persiste solicitudes idempotentes, serializa concurrencia por sesión y notifica `waiter_assistance` por `/ws/ui`. Admin incorpora `WaiterAssistancePanel` con estados `pending`/`attended`, separado de Cocina.
- Evidencia de superficie: `.sisyphus/evidence/fase4/browser_qa.mjs`, `live_http.mjs`, `admin_http.mjs` y capturas bajo `.sisyphus/evidence/fase4/`. Reporte: `.sisyphus/integration/FASE_4_ROBUSTEZ_CONVERSACIONAL_REPORTE.md`.
- Estado verificado el 2026-07-17: servicios Node/HTTP, PostgreSQL, Redis, Pipeline `:8001`, Whisper `:8002`, sidecar `:8100`, TTS `:3500` y WebSocket activos; `npm run build` exitoso; suite Node `78` (`77` aprobados, `1` fallo preexistente de downmix en `AudioFrameUtils.test.mjs`). `pytest tests/` y `pytest dialogue/tests` no pudieron recolectar porque esas rutas no existen en este checkout.

---

## VARIABLES DE ENTORNO (.env)

```bash
# API Keys (configured in .env — NEVER commit actual keys)
#
OPENROUTER_API_KEY=configured_in_dotenv
OPENROUTER_API_KEY=configured_in_dotenv
OPENROUTER_MODEL=deepseek/deepseek-v4-flash
OPENROUTER_FALLBACK_MODEL=meta-llama/llama-3.1-8b-instruct

# TTS
TTS_ENGINE=piper                       # piper | kokoro
PIPER_BIN=/home/david/.local/bin/piper
PIPER_MODEL=./models/piper/es_ES-davefx-medium.onnx
PIPER_CONFIG=./models/piper/es_ES-davefx-medium.onnx.json

# Bases de datos
SQLITE_PATH=./data/robot_mesero.db
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=chipi
POSTGRES_PASSWORD=CHANGE_ME        # Ver shared/credentials/CREDENTIALS.md
POSTGRES_DB=robot_mesero
REDIS_HOST=localhost
REDIS_PORT=6379
CHROMA_HOST=localhost
CHROMA_PORT=8000
INFLUX_URL=http://localhost:8086
INFLUX_TOKEN=CHANGE_ME             # Ver shared/credentials/CREDENTIALS.md
INFLUX_ORG=utec
INFLUX_BUCKET=robot_telemetry

# LLM — OpenRouter activo. GeminiAdapter.mjs queda solo como compatibilidad legacy.
# ⚠️ Gemini para LLM: descartado completamente. Todo el LLM conversacional va por OpenRouter.
# ⚠️ DashScope (Qwen directo) deprecado — todo vía OpenRouter
#

# VisionProvider (análisis de imágenes) — todo via OpenRouter
# Primary: google/gemma-4-31b-it:free (gratis, 1000 req/día, Apache 2.0)
# Alt:     moonshotai/kimi-k2.6:free (gratis, mejores benchmarks)
# Mid:     stepfun/step-3.7-flash ($0.20/M, 196B MoE, visión fuerte)
# DeepSeek V4 Flash via OpenRouter (ACTIVO — LLM conversacional primario)
# Más rápido que V4 Flash (2.7s vs 4.7s), sin reasoning tokens, $0.04/M
OPENROUTER_MODEL=deepseek/deepseek-v4-flash

# Llama 3.1 8B Instruct via OpenRouter (fallback rápido — 0.65s latencia)
# Excelente para roleplay peruano, $0.02/M input, $0.03/M output
OPENROUTER_FALLBACK_MODEL=meta-llama/llama-3.1-8b-instruct

# Qwen3 VL 8B (visión — descripción de imagen)
# Cascade: Qwen describe → DeepSeek refina texto final
OPENROUTER_VISION_MODEL=qwen/qwen3-vl-8b-instruct

# Qwen3.5:9B (Ollama local — offline fallback terciario)
OLLAMA_HOST=http://localhost:11434
QWEN35_9B_MODEL=qwen3.5:9b

# ROS2
ROS2_DOMAIN_ID=42
FOXGLOVE_BRIDGE_WS=ws://localhost:8765

# GPU Manager
GPU_MANAGER_MAX_VRAM_MB=16384         # RTX 5000

# Audio Pipeline
WAKE_WORD=Uchino
WAKE_WORD_THRESHOLD=0.5
WAKE_WORD_PATIENCE=3
WLK_HOST=127.0.0.1
WLK_PORT=8002
PIPELINE_PORT=8001

# Red WiFi ESP32
WIFI_SSID=robot_mesero_2.4G
WIFI_PASSWORD=CHANGE_ME           # Ver shared/credentials/CREDENTIALS.md
ESP32_WS_URL=ws://<backend-host>:3005/ws/robot

# RPi5 (SSH)
RPI5_HOST=<rpi5-host>
RPI5_USER=<rpi5-user>
RPI5_PASSWORD=CHANGE_ME           # Ver shared/credentials/CREDENTIALS.md
RPI5_ROS2_DOMAIN_ID=42

# Seguridad
JWT_SECRET=CHANGE_ME              # Ver shared/credentials/CREDENTIALS.md

# General
PORT=3005
NODE_ENV=development
RESTAURANTE_NOMBRE=Cafetería UTEC
ROBOT_NOMBRE=Uchino
```

---

## CONVENCIONES

- **Servidor v3**: Node.js con ES modules (`.mjs`), Express, WebSocket nativo
- **Módulos Python**: asyncio + websockets, ejecutados con `python -m modulo.archivo`
- **Frontend**: React 19 + Vite + Tailwind CSS v4, HashRouter, **multi-page build** (robot/cocina/admin separados)
- **Build multi-page**: `npm run build` genera `dist/robot.html`, `dist/cocina.html`, `dist/admin.html` con bundles independientes. Server sirve `/robot`→`robot.html`, etc.
- **Docker**: `docker compose -f docker/docker-compose.infra.yml up -d` para infraestructura
- **Scripts**: Bash para orquestación
- **Memoria dual**: `memory_db/` (Node.js — SQLite+PostgreSQL+Redis+ChromaDB) + `memory/` (Python — mem0 + person memory)
- **TTS dual**: `tts/` (Python — Kokoro primary + Piper fallback) + `backend_api/` (Node.js — PiperTTS legacy)
- **Orquestador sidecar**: `orchestrator/server.py` (FastAPI en :8100) — ruta primaria del pipeline de voz (fast rules + diálogo + memoria + TTS); el backend Node.js (:3005) es la ruta primaria y llama al sidecar con fallback inline si no responde
- **Modelos**: Piper TTS ONNX local, DeepSeek/Llama vía OpenRouter, Qwen3 VL para visión, WhisperLiveKit/faster-whisper local, Kokoro ONNX local
- **ESP32 audio legacy**: PlatformIO, WiFi `robot_mesero_2.4G`, WS al backend v3.
- **ESP32 base motors**: firmware activo en `workspace_esp32/firmware/base_motors` usa ESP-IDF + zenoh-pico. La RPi5 corre el peer host en `tcp/0.0.0.0:7447`; parar `esp32_bridge.service` antes de pruebas Zenoh porque ese servicio usa el puente serial Arduino legacy.
- **Python venv**: `WhisperLiveKit/venv/` (compartido entre módulos Python)
- **UI Generativa (planificado)**: CopilotKit (31K⭐) permitirá al LLM modificar la pantalla del robot por function calling. Ver `docs/COPILOTKIT_BACKLOG.md`. Gap 8.1 🟡

### Fase 5 — Modificadores, alergias y restricciones

- PostgreSQL conserva el menú existente y añade de forma compatible los campos JSONB de ingredientes, alérgenos, restricciones y modificadores. Las fichas legacy sin información se consideran incompletas; no se rellenan con datos inventados.
- `Fase5IntentRules` clasifica antes del LLM las operaciones de modificadores, observaciones, alergias, restricciones y consultas. `OrderSessionManager` conserva un único draft y separa variantes por `item_id`; los precios se recalculan desde el menú real también en `registrar_pedido`.
- La confirmación con alergia, restricción no verificada, ficha incompleta o modificador crítico exige una decisión explícita. Las respuestas nunca garantizan ausencia de contaminación cruzada. `pedido_eventos` conserva auditoría de cambios y consultas, y Admin expone pedidos/eventos de revisión especial.
- `/robot` ofrece edición por unidad y muestra advertencias; `/cocina` proyecta modificaciones, observaciones y alertas sin perderlas al cambiar estado; `/admin` gestiona la ficha de seguridad del menú y revisa eventos. Se mantiene intacta la simulación ROS 2 de Fase 3.
- Evidencia de cierre 2026-07-17: Fase 5 `24/24` tests, suite Node `121` (`119` pass y dos fallas preexistentes), build Vite exitoso, HTTP/WebSocket real y UI `800x480`; revisar `.sisyphus/integration/FASE_5_MODIFICADORES_ALERGIAS_REPORTE.md`.

---

## COMANDOS RÁPIDOS

```bash
# Iniciar todo (v3)
cd ~/chipi_workspace_pln/v3_core && bash start_robot.sh

# Solo Docker
docker compose -f docker/docker-compose.infra.yml up -d

# Orquestador sidecar (FastAPI :8100)
cd v3_core && python3 -m uvicorn orchestrator.server:app --host 127.0.0.1 --port 8100

# Solo backend v3
cd backend_api && node src/server.mjs

# Rebuild frontend
cd frontend_ui && npm run build

# Ver logs
tail -f shared/logs/backend_v3.log

# Tests Node.js (cobertura verificada al cierre de Fase 5: 121 tests; 119 pass y 2 fallas preexistentes)
find backend_api/tests llm_brain/tests memory_db/tests -name "*.test.mjs" | xargs node --test
# o por paquete:
cd backend_api && npm test
cd llm_brain && npm test

# Tests Python (este checkout no contiene el directorio tests/ activo)
python3 -m pytest tests/ -v

# Estado servicios
curl http://localhost:3005/api/status
curl http://localhost:3005/api/menu

# Pipeline de audio (puerto 8001)
bash start_pipeline.sh

# STT Whisper (puerto 8002)
bash start_stt.sh

# Monitor GPU
watch -n 1 nvidia-smi
```

---

*Para reglas globales del workspace (🚫 Hard Rules, 🔒 Security, 🌿 Git, 🔄 Maintenance), ver `AGENTS.md` en la raíz del proyecto.*
