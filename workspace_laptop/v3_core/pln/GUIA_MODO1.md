# 🎤 GUÍA COMPLETA: Cómo Hablarle al Robot (Modo 1)

## Estado Actual (2026-06-18 21:35)

✅ **TODO ESTÁ CORRIENDO**

| Servicio | Puerto | Estado |
|----------|--------|--------|
| Backend API | :3005 | ✅ Activo |
| Audio Pipeline | :8001 | ✅ Activo (Wake word + noise suppression) |
| WhisperLiveKit | :8002 | ✅ Activo (STT) |
| PLN Service | N/A | ✅ Activo (Nuevo módulo de voz) |
| TTS (Piper) | N/A | ✅ Activo (en backend) |

---

## 🎙️ CÓMO HABLARLE AL ROBOT

### Flujo Completo

```
1. TÚ dices: "Oye Uchino, quiero una pizza margarita"
        ↓
2. Micrófono de tu laptop captura el audio
        ↓
3. Audio Pipeline (:8001) detecta "Oye Uchino" (wake word)
        ↓
4. Pipeline envía audio a WhisperLiveKit (:8002)
        ↓
5. WhisperLiveKit transcribe: "quiero una pizza margarita"
        ↓
6. Pipeline envía transcripción al PLN Service
        ↓
7. PLN procesa:
   - Fast rule? No → Llama al LLM
   - DeepSeek V4 Flash genera respuesta
   - OrderExtractor parsea: 1x Pizza Margarita
        ↓
8. PLN envía POST /api/pedidos {modo: "voz", ...}
        ↓
9. Backend guarda en PostgreSQL
        ↓
10. Backend envía vía WebSocket a Cocina/Admin/Robot
        ↓
11. Backend TTS (Piper) genera audio de respuesta
        ↓
12. Robot habla por el ALTAVOZ de tu laptop:
    "¡Listo causa! Tu pizza margarita ya está en camino"
```

---

## 🖥️ Servicios en tmux (Todo Automático)

Los 6 servicios están corriendo en sesiones tmux:

```bash
$ tmux ls

audio-pipeline  →  Wake word + noise suppression
whisper         →  Speech-to-Text (faster-whisper)
pln             →  PLN Service (NUEVO)
backend         →  Backend API Node.js
frontend        →  Frontend Vite
```

**Para ver lo que está pasando en tiempo real:**
```bash
# Ver el PLN procesando comandos
tmux attach -t pln

# Ver el audio pipeline detectando wake words
tmux attach -t audio-pipeline

# Ver las transcripciones del STT
tmux attach -t whisper

# Salir de tmux (sin matar el proceso): Ctrl+B, luego D
```

---

## 🧪 PROBAR AHORA MISMO

### Opción 1: Prueba con Simulación (Sin Micrófono)

```bash
cd ~/chipi_workspace_pln/v3_core
source WhisperLiveKit/venv/bin/activate

python3 -c "
from v3_core.pln.main import ChipiPLN
import asyncio

async def test():
    pln = ChipiPLN()
    print('🎤 Simulando: Oye Uchino...')
    await pln._on_wake_word()
    
    print('🗣️  Simulando: Quiero una pizza margarita')
    await pln._on_transcription('quiero una pizza margarita')
    
    print('✅ Test completado! Revisa http://localhost:3005/cocina')

asyncio.run(test())
"
```

### Opción 2: Hablar por el Micrófono de la Laptop

**IMPORTANTE:** El sistema ya está escuchando a través del micrófono de tu laptop.

1. **Asegúrate de que el micrófono esté activo:**
   ```bash
   # Verificar dispositivos de audio
   arecord -l
   ```

2. **Di claramente:**
   ```
   "Oye Uchino, quiero una pizza margarita"
   ```

3. **Espera la respuesta:** El robot responderá por el altavoz de tu laptop.

4. **Verifica el pedido:** Abre http://localhost:3005/cocina y debería aparecer el pedido.

---

## 🔧 CONFIGURACIÓN DEL MICRÓFONO

### Verificar Micrófono
```bash
# Listar dispositivos de audio
arecord -l

# Probar grabación (5 segundos)
arecord -d 5 test.wav

# Reproducir
aplay test.wav
```

### Si el micrófono no funciona:
1. Abre **Configuración de Sonido** en Ubuntu
2. Ve a la pestaña **Entrada**
3. Selecciona el micrófono de tu laptop
4. Ajusta el volumen al 80%

---

## 📊 Páginas Disponibles

| URL | Descripción | Qué Ver |
|-----|-------------|---------|
| http://localhost:3005/robot | 🤖 Pantalla Robot | El robot interactuando |
| http://localhost:3005/cocina | 👨‍🍳 Cocina KDS | Pedidos en tiempo real |
| http://localhost:3005/admin | 🖥️ Admin Dashboard | Control completo |

---

## 🎯 COMANDOS DE VOZ Soportados

### Wake Word (Palabra de Activación)
- **"Oye Uchino"** - Activa el robot

### Fast Rules (Respuestas Inmediatas)
- **"Hola" / "Buenas"** → Saludo del robot
- **"Gracias" / "Chao"** → Despedida
- **"Ayuda" / "Emergencia"** → Alerta
- **"Cancelar" / "Ya no quiero"** → Cancela pedido

### Pedidos (Ejemplos)
- "Quiero una pizza margarita"
- "Dame dos cervezas y una hamburguesa"
- "Para la mesa 5, tres ceviches"
- "Una coca cola y una ensalada"

---

## 🚨 TROUBLESHOOTING

### "No escucha el wake word"
```bash
# Verificar que el pipeline está corriendo
tmux attach -t audio-pipeline

# Verificar micrófono
arecord -l
```

### "No transcribe mi voz"
```bash
# Verificar WhisperLiveKit
tmux attach -t whisper

# Reiniciar si es necesario
tmux kill-session -t whisper
tmux new-session -d -s whisper "cd ~/chipi_workspace_pln/v3_core && source WhisperLiveKit/venv/bin/activate && wlk --backend faster-whisper --model large-v3-turbo --language es --pcm-input --port 8002"
```

### "No aparece el pedido en Cocina"
```bash
# Verificar backend
curl http://localhost:3005/api/status

# Verificar PLN
tmux attach -t pln
```

### "El robot no habla"
```bash
# Verificar TTS (Piper)
curl http://localhost:3005/api/status | grep -A 2 tts

# Debería mostrar: "piper": true
```

---

## 📈 Monitoreo en Tiempo Real

```bash
# Ver logs de todos los servicios
tail -f ~/chipi_workspace_pln/v3_core/shared/logs/*.log

# Ver pedidos en tiempo real
watch -n 1 'curl -s http://localhost:3005/api/pedidos | python3 -m json.tool | head -20'

# Ver estado de servicios
curl http://localhost:3005/api/status | python3 -m json.tool
```

---

## ✅ CHECKLIST PARA USAR MODo 1

- [ ] Laptop encendida con micrófono funcionando
- [ ] Servicios corriendo (verificar con `tmux ls`)
- [ ] Navegador abierto en http://localhost:3005/cocina (para ver pedidos)
- [ ] Decir "Oye Uchino" para activar
- [ ] Decir el pedido claramente
- [ ] Verificar que aparece en Cocina/Admin

---

## 🎉 RESUMEN

**¿Cómo hablarle al robot?**

1. Di: **"Oye Uchino"** (el micrófono ya está escuchando)
2. Di tu pedido: **"Quiero una pizza margarita"**
3. El robot responde por el **altavoz de tu laptop**
4. El pedido aparece automáticamente en **Cocina y Admin**

**¿Qué falta?**
- ❌ Nada. Todo está corriendo y listo para usar.
- ⚠️ Nota: El Orchestrator (:8100) tiene warnings pero no afecta el Modo 1.
- ⚠️ Nota: La memoria (historial de clientes) no está disponible aún.

**¡TODO LISTO PARA HABLAR CON UCHINO! 🎤🤖**

---

**Documento generado:** 2026-06-18  
**Actualizado automáticamente por el sistema**