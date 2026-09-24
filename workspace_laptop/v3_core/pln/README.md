# PLN — Procesamiento de Lenguaje Natural (Voice Pipeline)

Módulo de procesamiento de voz del Robot Mesero Uchino. Permite tomar pedidos por voz (Modo 1), complementando los modos táctiles ya funcionales (Modo 2: Robot, Modo 3: Admin).

## Arquitectura

```
ESP32 (I2S mic) ──WS──► audio_pipeline (:8001)
                                │
                       ┌────────┴────────┐
                       │ Wake Word       │
                       │ "Oye Uchino"     │
                       └────────┬────────┘
                                │ activated
                       ┌────────┴────────┐
                       │ WhisperLiveKit   │
                       │ (:8002) STT      │
                       └────────┬────────┘
                                │ text
                       ┌────────┴────────┐
                       │ PLN Module      │
                       │ (this module)   │
                       │                 │
                       │ ┌─────────────┐ │
                       │ │ AudioRouter │ │──► Wake word + STT
                       │ └──────┬──────┘ │
                       │        │         │
                       │ ┌──────▼──────┐ │
                       │ │ Dialogue    │ │──► Fast rules + LLM
                       │ │ Integrator  │ │
                       │ └──────┬──────┘ │
                       │        │         │
                       │ ┌──────▼──────┐ │
                       │ │ Order        │ │──► Parse orders
                       │ │ Extractor   │ │
                       │ └──────┬──────┘ │
                       │        │         │
                       │ ┌──────▼──────┐ │
                       │ │ WS Client   │ │──► POST /api/pedidos
                       │ └─────────────┘ │
                       └─────────────────┘
                                │
                       ┌────────┴────────┐
                       │ Backend (:3005) │
                       │ POST /api/pedidos│
                       │ modo: "voz"     │
                       └─────────────────┘
```

## Máquina de Estados

```
SLEEP ──(wake word)──► AWAKE ──(listening)──► LISTENING ──(transcription)──► THINKING
  ▲                                                                                     │
  │                                              ┌──────────────────────────────────────┘
  │                                              ▼
  └──────────────────────────────────── RESPONDING ◄── THINKING
                                              │
                                              ▼
                                       CONFIRMING_ORDER
                                              │
                                              ▼
                                          DELIVERING ──► LISTENING (continue) or SLEEP (done)
```

## Modelos de IA

| Rol | Modelo | Proveedor | Uso |
|-----|--------|-----------|-----|
| Texto/Roleplay | DeepSeek V4 Flash | OpenRouter | LLM primario para diálogo (max_tokens=200) |
| Fallback texto | Llama 3.1 8B Instruct | OpenRouter | Si DeepSeek falla (0.65s latencia) |
| Offline | Qwen3.5:9B | Ollama local | Si todo falla |
| Visión | Qwen3 VL 8B → DeepSeek V4 Flash | OpenRouter | Cascade: describe → refina |

**Pipeline de visión (cascada secuencial):**
1. Cámara → Qwen3 VL 8B describe la imagen → descripción textual
2. Descripción → DeepSeek V4 Flash genera respuesta con jerga peruana

**Cadena de fallback texto:**
DeepSeek V4 Flash → Llama 3.1 8B Instruct → Ollama Qwen3.5:9B

## Uso

### Inicio manual
```bash
cd ~/chipi_workspace_pln/v3_core
bash start_pln.sh
```

### Inicio con systemd
```bash
sudo cp systemd/chipi-pln.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable chipi-pln
sudo systemctl start chipi-pln
```

### Verificar
```bash
# Verificar que el módulo importa correctamente
python3 -c "from v3_core.pln.main import ChipiPLN; print('OK')"
```

## Archivos

| Archivo | Descripción |
|---------|-------------|
| `main.py` | Entry point del servicio continuo |
| `types.py` | ChipiState enum, OrderItem, DialogueContext, PLNResponse |
| `config.py` | Constantes y URLs desde .env |
| `states.py` | Máquina de estados y transiciones |
| `audio_router.py` | Conexión con audio_pipeline y WhisperLiveKit |
| `dialogue_integrator.py` | Fast rules, LLM bridge, pipeline de visión |
| `order_extractor.py` | Parseo de pedidos del texto del LLM |
| `ws_client.py` | Cliente WebSocket para enviar pedidos al backend |

## Puertos

| Puerto | Servicio | Descripción |
|--------|----------|-------------|
| 3005 | Backend API | POST /api/pedidos, GET /api/menu, /api/llm |
| 8001 | Audio Pipeline | Wake word + DeepFilterNet3 + SER |
| 8002 | WhisperLiveKit | STT (faster-whisper large-v3-turbo) |
| 8100 | Orchestrator | TTS (Kokoro/Piper), diálogo LangGraph |

## Variables de Entorno

Ver `v3_core/.env` para la configuración completa. Variables relevantes:

- `OPENROUTER_MODEL` — LLM primario (default: deepseek/deepseek-v4-flash)
- `OPENROUTER_FALLBACK_MODEL` — LLM fallback (default: `meta-llama/llama-3.1-8b-instruct`)
- `OPENROUTER_VISION_MODEL` — LLM de visión (default: `qwen/qwen3-vl-8b-instruct`)
- `OPENROUTER_VISION_MODEL` — VLM para visión (default: qwen/qwen3-vl-8b-instruct)
- `PIPELINE_PORT` — Puerto del audio pipeline (default: 8001)
- `WLK_PORT` — Puerto de WhisperLiveKit (default: 8002)
- `PORT` — Puerto del backend (default: 3005)
