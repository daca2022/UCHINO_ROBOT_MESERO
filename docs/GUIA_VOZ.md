# Guía de voz de UCHINO

Esta guía separa lo que funciona al clonar de lo que requiere descargar modelos
grandes. No necesitas instalar voz local para revisar las páginas.

## 1. Ruta recomendada: demo web

La ruta pública usa el navegador como respaldo:

- **STT:** `SpeechRecognition`/`webkitSpeechRecognition` de Chrome o Edge.
- **TTS:** `speechSynthesis` del navegador cuando no hay un reproductor local.
- **LLM y visión:** OpenRouter es opcional y solo se usa desde el backend.

Desde una terminal:

```bash
git clone https://github.com/daca2022/UCHINO_ROBOT_MESERO.git
cd UCHINO_ROBOT_MESERO/workspace_laptop/v3_core
cp .env.example .env
nano .env
bash start_web.sh
```

En `.env` define como mínimo valores propios para:

```dotenv
ADMIN_PASSWORD=una_clave_local
JWT_SECRET=una_cadena_larga_local
POSTGRES_PASSWORD=una_clave_local
INFLUX_TOKEN=un_token_local
GF_SECURITY_ADMIN_PASSWORD=otra_clave_local
```

Luego abre `http://localhost:3005/robot`, concede el micrófono y prueba
`Pedir por voz`. Esta ruta no descarga Whisper, Piper ni Kokoro.

## 2. LLM y visión mediante OpenRouter

OpenRouter no es un servicio de STT ni de TTS. Sirve para el LLM de texto y
para visión. La clave se crea en [OpenRouter](https://openrouter.ai/) y se
configura solamente en el `.env` del backend:

```dotenv
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=deepseek/deepseek-v4-flash
OPENROUTER_FALLBACK_MODEL=meta-llama/llama-3.1-8b-instruct
OPENROUTER_VISION_MODEL=qwen/qwen3-vl-8b-instruct
```

Consulta el [quickstart oficial de OpenRouter](https://openrouter.ai/docs/quickstart)
para crear y revocar la clave. No la pongas en React, en una variable `VITE_*`
ni en GitHub.

## 3. TTS local con Kokoro, opcional

El reproductor local que intenta iniciar el backend usa `tts/venv` y Kokoro.
El modelo se descarga desde Hugging Face la primera vez que Kokoro se carga;
no está guardado en GitHub.

En Ubuntu o WSL2:

```bash
cd UCHINO_ROBOT_MESERO/workspace_laptop/v3_core
sudo apt-get update
sudo apt-get install -y espeak-ng alsa-utils
python3 -m venv tts/venv
tts/venv/bin/python -m pip install --upgrade pip
tts/venv/bin/python -m pip install -r requirements.txt
```

La implementación usa el paquete [`kokoro`](https://github.com/hexgrad/kokoro)
y el modelo [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M). Reinicia el
backend con `bash start_web.sh` y comprueba:

```bash
curl http://localhost:3005/api/tts/status
```

Si `ready` sigue en `false`, la página continúa usando `speechSynthesis` del
navegador. Eso es una degradación prevista, no una falla de la interfaz.

## 4. Piper local, opcional e independiente

Piper es otra alternativa local. Su binario y sus voces no vienen en este
repositorio. La implementación actual conserva las variables de Piper como
compatibilidad para rutas de audio locales; no son necesarias para la demo web.

Referencias oficiales:

- [Motor Piper (Open Home Foundation)](https://github.com/OHF-Voice/piper1-gpl)
- [Voces Piper](https://huggingface.co/rhasspy/piper-voices/tree/main/es/es_ES/davefx/medium)

Instalación de una voz española de ejemplo:

```bash
cd UCHINO_ROBOT_MESERO/workspace_laptop/v3_core
python3 -m venv .venv-piper
.venv-piper/bin/python -m pip install --upgrade pip
.venv-piper/bin/python -m pip install piper-tts
# Descarga la voz española que espera este proyecto:
bash scripts/setup_piper_model.sh
```

Si una ruta local de tu instalación necesita Piper, usa rutas absolutas en
`.env`:

```dotenv
PIPER_BIN=/ruta/absoluta/UCHINO_ROBOT_MESERO/workspace_laptop/v3_core/.venv-piper/bin/piper
PIPER_MODEL=/ruta/absoluta/UCHINO_ROBOT_MESERO/workspace_laptop/v3_core/models/piper/es_ES-davefx-medium.onnx
PIPER_CONFIG=/ruta/absoluta/UCHINO_ROBOT_MESERO/workspace_laptop/v3_core/models/piper/es_ES-davefx-medium.onnx.json
```

No subas `.venv-piper`, el `.onnx` ni claves al repositorio.

## 5. STT local con WhisperLiveKit, opcional

La publicación no incluye el entorno `WhisperLiveKit/venv` ni el modelo
`large-v3-turbo`. Para instalarlos, sigue el [repositorio oficial de
WhisperLiveKit](https://github.com/niaodian/whisperlivekit):

```bash
cd UCHINO_ROBOT_MESERO/workspace_laptop/v3_core
git clone https://github.com/niaodian/whisperlivekit.git WhisperLiveKit
python3 -m venv WhisperLiveKit/venv
source WhisperLiveKit/venv/bin/activate
python -m pip install --upgrade pip
# CPU:
python -m pip install "whisperlivekit[cpu]"
# En una GPU compatible, usa la variante CUDA indicada por el proyecto.
deactivate
bash start_stt.sh
```

`start_stt.sh` inicia `large-v3-turbo` en español; el peso se descarga cuando
WhisperLiveKit lo necesita. Si no instalas esta ruta, el STT del navegador sigue
disponible para la demostración.

## 6. Qué instalar y qué no

| Objetivo | Se instala desde GitHub | Se descarga aparte |
|---|---|---|
| Ver las tres páginas | Código, `npm ci` y `start_web.sh` | Docker descarga sus imágenes |
| Voz básica | Código del frontend | Nada; usa Chrome/Edge |
| LLM/visión | Integración del backend | Tu `OPENROUTER_API_KEY` |
| TTS local | Código `tts/` | Python, Kokoro, pesos y `alsa-utils` |
| STT local | `start_stt.sh` | WhisperLiveKit, entorno Python y `large-v3-turbo` |
| Robot físico | No pertenece a esta publicación | ROS2, RPi5, ESP32, sensores y red |

No ejecutes todos los `.sh` al clonar. Para la publicación web basta
`start_web.sh`; `start_robot.sh`, `start_pipeline.sh` y `start_stt.sh` son rutas
opcionales que requieren dependencias adicionales.

## 7. APIs de voz

Actualmente no hay una API externa de STT/TTS conectada al repositorio público.
OpenRouter no puede sustituir esas dos funciones. Si se desea una modalidad
cloud, hay que integrar un proveedor de audio específico en el backend, guardar
su clave en `.env`, documentar su coste y conservar el fallback del navegador.
No se debe añadir una variable de API que el código todavía no consume.
