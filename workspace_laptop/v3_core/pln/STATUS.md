# Estado Actual del Sistema PLN - Modo 1 (Voz)

**Fecha:** 2026-06-18
**Plan:** `.sisyphus/plans/pln-integration.md`
**Estado:** Implementación completa, servicios pendientes de inicio

---

## ✅ Servicios CORRIENDO Ahora (2026-06-18 21:24)

| Servicio | Puerto | Estado | Descripción |
|----------|--------|--------|-------------|
| **Backend API** | :3005 | ✅ **ACTIVO** | Express + WebSocket, maneja pedidos, menú, LLM bridge |
| **Audio Pipeline** | :8001 | ✅ **ACTIVO** | Wake word "Oye Uchino" + DeepFilterNet3 + SER |
| **WhisperLiveKit** | :8002 | ✅ **ACTIVO** | STT (Speech-to-Text) con faster-whisper |
| **Orchestrator** | :8100 | ✅ **ACTIVO** | LangGraph + TTS (Kokoro/Piper) |
| **PLN Service** | N/A | ✅ **ACTIVO** | Módulo de voz (nuevo) |
| **PostgreSQL** | :5432 | ✅ **ACTIVO** | Base de datos de pedidos, menú, clientes |
| **Redis** | :6379 | ✅ **ACTIVO** | Cache y estado en tiempo real |
| **ChromaDB** | :8000 | ✅ **ACTIVO** | Base de datos vectorial para embeddings |
| **Grafana** | :3000 | ✅ **ACTIVO** | Dashboards de monitoreo |
| **InfluxDB** | :8086 | ✅ **ACTIVO** | Métricas y logs |

### Sesiones tmux activas
```
audio-pipeline: Audio Pipeline (wake word + noise suppression)
backend: Backend API Node.js
frontend: Frontend Vite
orchestrator: Orchestrator Python (LangGraph + TTS)
pln: PLN Service (nuevo módulo de voz)
whisper: WhisperLiveKit STT
```

---

## 🧠 Memoria - Estado Detallado

### ¿Qué hay?
- **PostgreSQL**: Guarda pedidos, menú, historial completo
- **Redis**: Estado en tiempo real, sesiones
- **ChromaDB**: Embeddings vectoriales para búsqueda semántica
- **mem0/person_memory**: Existe en el backend pero **no está expuesto vía REST**

### ¿Qué falta?
- **Endpoint REST para memoria**: El PLN intenta llamar `GET /api/memory/{client_id}` pero este endpoint **NO EXISTE** en `backend_api/src/index.mjs`
- **Integración mem0**: La memoria funciona internamente en el backend pero no es accesible desde el PLN

### Solución temporal
El PLN usa `DialogueContext.client_info` para mantener contexto de la conversación actual, pero no tiene acceso a historial de conversaciones previas del cliente.

---

## 🌐 Integración Frontend - Cómo Funciona

### Flujo de Pedidos (Todos los Modos)

```
┌─────────────────────────────────────────────────────────────┐
│                     BACKEND (:3005)                         │
│                                                             │
│  POST /api/pedidos  ──►  Guarda en PostgreSQL              │
│  {mesa, platos, total, modo}                                │
│        │                                                    │
│        ▼                                                    │
│  sendToUI({type: 'nuevo_pedido', pedido})                   │
│        │                                                    │
│        ▼                                                    │
│  WebSocket /ws/ui                                           │
└────────────────────────┬────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   ┌──────────┐   ┌──────────┐   ┌──────────┐
   │  Cocina  │   │  Admin   │   │  Robot   │
   │  (KDS)   │   │ Dashboard│   │  Screen  │
   │          │   │          │   │          │
   │ Recibe   │   │ Recibe   │   │ Recibe   │
   │ pedidos  │   │ pedidos  │   │ pedidos  │
   │ en vivo  │   │ en vivo  │   │ en vivo  │
   └──────────┘   └──────────┘   └──────────┘
```

### Modos de Pedido

| Modo | Valor `modo` | Origen | Descripción |
|------|-------------|--------|-------------|
| **Modo 1** | `"voz"` | PLN (voz) | Pedido por voz del cliente |
| **Modo 2** | `"touch_robot"` | RobotScreen.jsx | Pedido desde pantalla táctil del robot |
| **Modo 3** | `"touch_admin"` | AdminDashboard.jsx | Pedido desde dashboard del administrador |

### URLs Frontend
- `http://localhost:3005/robot` - Pantalla del robot (7")
- `http://localhost:3005/cocina` - KDS Cocina
- `http://localhost:3005/admin` - Dashboard Admin

---

## ✅ Estado Actual (2026-06-18 21:24)

**TODO ESTÁ CORRIENDO** 🎉

Los 5 servicios principales están activos y funcionando:
1. ✅ Backend API (:3005)
2. ✅ Audio Pipeline (:8001)
3. ✅ WhisperLiveKit (:8002)
4. ✅ Orchestrator (:8100)
5. ✅ PLN Service

### Cómo verificar
```bash
echo "Backend:" && curl -s http://localhost:3005/api/status | head -c 50
echo -e "\nPipeline:" && ss -tlnp | grep 8001 | head -1
echo "STT:" && ss -tlnp | grep 8002 | head -1
echo "Orchestrator:" && curl -s http://localhost:8100/health | head -c 50
echo -e "\nPLN:" && ps aux | grep "pln.main" | grep -v grep | wc -l && echo "proceso(s)"
```

## 🚀 Cómo Activar Modo 1 (Si se reinicia)

Los servicios están corriendo en tmux. Si necesitas reiniciarlos:

```bash
# Ver sesiones activas
tmux ls

# Adjuntar a una sesión (para ver logs)
tmux attach -t pln          # PLN Service
tmux attach -t audio-pipeline  # Audio Pipeline
tmux attach -t whisper      # WhisperLiveKit
tmux attach -t orchestrator # Orchestrator
tmux attach -t backend      # Backend API

# Salir de tmux sin matar el proceso: Ctrl+B, luego D
```

### Si un servicio se cae, reiniciarlo:

**Audio Pipeline:**
```bash
tmux kill-session -t audio-pipeline
tmux new-session -d -s audio-pipeline "cd ~/chipi_workspace_pln/v3_core && bash start_pipeline.sh 2>&1 | tee -a shared/logs/pipeline.log"
```

**WhisperLiveKit:**
```bash
tmux kill-session -t whisper
tmux new-session -d -s whisper "cd ~/chipi_workspace_pln/v3_core && source WhisperLiveKit/venv/bin/activate && wlk --backend faster-whisper --model large-v3-turbo --language es --pcm-input --port 8002 2>&1 | tee -a shared/logs/stt.log"
```

**Orchestrator:**
```bash
tmux kill-session -t orchestrator
tmux new-session -d -s orchestrator "cd ~/chipi_workspace_pln/v3_core && source WhisperLiveKit/venv/bin/activate && python3 -m uvicorn orchestrator.server:app --host 127.0.0.1 --port 8100 2>&1 | tee -a shared/logs/orchestrator.log"
```

**PLN Service:**
```bash
tmux kill-session -t pln
tmux new-session -d -s pln "cd ~/chipi_workspace_pln/v3_core && export PYTHONPATH=/home/david/chipi_workspace_pln && source WhisperLiveKit/venv/bin/activate && python3 -m pln.main 2>&1 | tee -a shared/logs/pln.log"
```

---

## 🔧 Comandos Útiles

### Verificar todo de una vez
```bash
echo "Backend:" && curl -s http://localhost:3005/api/status | head -c 100
echo -e "\nPipeline:" && curl -s http://localhost:8001/health 2>/dev/null || echo "OFF"
echo -e "\nSTT:" && curl -s http://localhost:8002/health 2>/dev/null || echo "OFF"
echo -e "\nOrchestrator:" && curl -s http://localhost:8100/health 2>/dev/null || echo "OFF"
```

### Ver logs en tiempo real
```bash
# Terminal 1: Backend
tail -f ~/chipi_workspace_pln/v3_core/shared/logs/backend_v3.log

# Terminal 2: PLN
tail -f ~/chipi_workspace_pln/v3_core/shared/logs/pln.log

# Terminal 3: Audio Pipeline
tail -f ~/chipi_workspace_pln/v3_core/shared/logs/pipeline.log
```

### Probar el PLN manualmente (sin audio)
```bash
cd ~/chipi_workspace_pln/v3_core
python3 -c "
from v3_core.pln.main import ChipiPLN
import asyncio

async def test():
    pln = ChipiPLN()
    # Simular wake word
    await pln._on_wake_word()
    # Simular transcripción
    await pln._on_transcription('quiero una pizza margarita')
    print('Test completado')

asyncio.run(test())
"
```

---

## 📊 Arquitectura del PLN

```
┌─────────────────────────────────────────────────────────────┐
│                     HARDWARE                                │
│                                                             │
│  ESP32 (micrófono I2S)  ──────►  Laptop (procesamiento)   │
│  ESP32 (altavoz I2S)    ◄──────  RPi5 (pantalla 7")       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  AUDIO PIPELINE (:8001)                     │
│                                                             │
│  OpenWakeWord ("Oye Uchino")                                │
│  DeepFilterNet3 (supresión de ruido)                       │
│  wav2vec2 SER (emociones)                                  │
│                                                             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│               WhisperLiveKit (:8002)                        │
│                                                             │
│  faster-whisper large-v3-turbo                             │
│  SimulStreaming (transcripción en tiempo real)             │
│                                                             │
└────────────────────────┬────────────────────────────────────┘
                         │ Texto
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    PLN MODULE (NUEVO)                       │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │AudioRouter   │──►│Dialogue      │──►│Order         │     │
│  │              │   │Integrator    │   │Extractor     │     │
│  │• Wake word   │   │              │   │              │     │
│  │• STT         │   │• Fast rules  │   │• NL parsing  │     │
│  │• State mgmt  │   │• LLM bridge  │   │• Menu match  │     │
│  └──────────────┘   │• Vision      │   │• modo="voz"  │     │
│                     └──────┬───────┘   └──────┬───────┘     │
│                            │                    │             │
│                            ▼                    ▼             │
│                     ┌──────────────┐   ┌──────────────┐     │
│                     │ WSClient     │   │ TTS          │     │
│                     │              │   │ (Orchestrator│     │
│                     │• POST        │   │ :8100)       │     │
│                     │ /api/pedidos │   │              │     │
│                     │• WS /ws/ui   │   │• Kokoro      │     │
│                     └──────┬───────┘   │• Piper       │     │
│                            │           └──────────────┘     │
│                            ▼                                │
│                     ┌──────────────┐                        │
│                     │ Backend      │                        │
│                     │ (:3005)      │                        │
│                     └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

---

## 🎯 Prioridades para el Futuro

### Alta Prioridad
1. **Crear endpoint de memoria**: `GET /api/memory/:clientId` para que el PLN acceda a historial
2. **Iniciar servicios faltantes**: Pipeline, STT, Orchestrator, PLN
3. **Prueba end-to-end**: Verificar que un pedido por voz llega a Cocina/Admin

### Media Prioridad
1. **Integrar visión**: Qwen3 VL 8B para analizar caras/emociones del cliente
2. **Optimizar latencia**: Reducir tiempo de respuesta (< 5 segundos objetivo)
3. **Manejo de errores**: Fallbacks cuando servicios están caídos

### Baja Prioridad
1. **Mejorar extracción de pedidos**: Más robusto con variaciones de lenguaje
2. **Personalización**: Aprender preferencias del cliente
3. **Métricas**: Logging de latencia, tasa de éxito, etc.

---

## 📞 Troubleshooting

### Problema: "No se escucha el wake word"
**Causa probable:** Audio Pipeline no está corriendo
**Solución:**
```bash
cd ~/chipi_workspace_pln/v3_core
bash start_pipeline.sh
```

### Problema: "El STT no transcribe"
**Causa probable:** WhisperLiveKit no está corriendo o modelo no descargado
**Solución:**
```bash
cd ~/chipi_workspace_pln/v3_core/WhisperLiveKit
bash download_model.sh  # Descargar modelo
bash start_stt.sh
```

### Problema: "No hay respuesta de voz"
**Causa probable:** Orchestrator no está corriendo o TTS falla
**Solución:**
```bash
# Verificar orchestrator
curl http://localhost:8100/health

# Verificar modelos TTS
ls ~/chipi_workspace_pln/v3_core/models/*.onnx
```

### Problema: "Los pedidos no aparecen en Cocina/Admin"
**Causa probable:** WebSocket no está conectado
**Solución:**
```bash
# Verificar que backend está enviando mensajes
curl http://localhost:3005/api/pedidos

# Verificar conexión WebSocket
# Abrir consola del navegador en http://localhost:3005/cocina
# Verificar mensajes WS
```

---

## ✅ Checklist de Verificación

Antes de declarar que Modo 1 está funcionando:

- [ ] Audio Pipeline corriendo (:8001)
- [ ] WhisperLiveKit corriendo (:8002)
- [ ] Orchestrator corriendo (:8100)
- [ ] PLN Service corriendo
- [ ] Backend API corriendo (:3005)
- [ ] Docker services corriendo (PostgreSQL, Redis, ChromaDB)
- [ ] Frontend accesible (http://localhost:3005)
- [ ] Prueba: Decir "Oye Uchino, quiero una pizza" crea pedido
- [ ] Prueba: Pedido aparece en Cocina KDS
- [ ] Prueba: Pedido aparece en Admin Dashboard
- [ ] Prueba: Robot responde con voz

---

**Documento generado automáticamente por el sistema de orquestación.**
**Última actualización:** 2026-06-18
**Plan:** `.sisyphus/plans/pln-integration.md`