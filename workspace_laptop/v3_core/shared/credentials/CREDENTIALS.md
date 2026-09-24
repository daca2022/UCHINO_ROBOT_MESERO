# Credenciales del Sistema — Robot Mesero Uchino

> **ADVERTENCIA:** Este archivo lista las variables de entorno requeridas.
> **LOS VALORES REALES SE GUARDAN EN `workspace_laptop/v3_core/.env` (gitignored).**
> En una instalación nueva, copia `.env.example` a `.env` y completa solo lo que uses.
> **NO escribir contraseñas en texto plano en archivos .md.**

## Referencia de Variables de Entorno

| Variable | Propósito | Valor por defecto |
|----------|-----------|-------------------|
| `POSTGRES_PASSWORD` | Password de PostgreSQL | — |
| `INFLUX_TOKEN` | Token de InfluxDB | — |
| `GF_SECURITY_ADMIN_PASSWORD` | Password de Grafana | — |
| `WIFI_PASSWORD` | Password de red WiFi ESP32 | — |
| `RPI5_PASSWORD` | Password SSH RPi5 | — |
| `OPENROUTER_API_KEY` | API Key de OpenRouter | — |
| `OPENROUTER_VISION_MODEL` | Modelo VLM backup (Qwen3 VL 8B) | qwen/qwen3-vl-8b-instruct |
| `JWT_SECRET` | Secreto JWT para auth | — |
| `ADMIN_USER` | Usuario del panel `/admin` y Cocina | admin |
| `ADMIN_PASSWORD` | Contraseña del panel `/admin` y Cocina | — |
| `ESPEAK_BIN` | Ejecutable TTS de sistema | espeak-ng |
| `VISION_MOCK` | Usa visión simulada sin cámara | true |

## Bases de Datos

| Servicio | Host | Puerto | Usuario | Password (env var) |
|----------|------|--------|---------|--------------------|
| PostgreSQL | localhost | 5432 | chipi | `${POSTGRES_PASSWORD}` |
| Redis | localhost | 6379 | — | sin auth |
| ChromaDB | localhost | 8000 | — | sin auth |
| InfluxDB | localhost | 8086 | chipi | `${INFLUX_TOKEN}` |

### Detalles PostgreSQL
- **DB name:** robot_mesero
- **Container:** chipi_postgres
- **Init scripts:** `./memory_db/src/migrations` montados en `/docker-entrypoint-initdb.d`

### Detalles InfluxDB
- **Org:** utec
- **Bucket:** robot_telemetry
- **Container:** chipi_influxdb

## Dashboards

| Servicio | URL | Usuario | Password (env var) |
|----------|-----|---------|--------------------|
| Grafana | http://localhost:3000 | admin | `${GF_SECURITY_ADMIN_PASSWORD}` |
| Admin Web | http://localhost:3005/admin | `${ADMIN_USER}` | `${ADMIN_PASSWORD}` o `${GF_SECURITY_ADMIN_PASSWORD}` |

## APIs Externas

| Servicio | Key/Token (env var) | Modelo/Config |
|----------|---------------------|---------------|
| OpenRouter — DeepSeek V4 Flash | `${OPENROUTER_API_KEY}` | deepseek/deepseek-v4-flash (primario texto) |
| OpenRouter — Llama 3.1 8B Instruct | `${OPENROUTER_API_KEY}` | meta-llama/llama-3.1-8b-instruct (fallback texto) |
| OpenRouter — Qwen3 VL 8B | `${OPENROUTER_API_KEY}` | `${OPENROUTER_VISION_MODEL}` → qwen/qwen3-vl-8b-instruct (visión) |
| Ollama (local) | — | qwen3.5:9b (fallback terciario) |
| Cloudflare Tunnel | (token en .env) | — |

### TTS Local (Piper)
- **Binario:** ./venv/bin/piper
- **Modelo:** ./models/piper/es_ES-davefx-medium.onnx
- **Config:** ./models/piper/es_ES-davefx-medium.onnx.json
- **Output rate:** 22050
- **Fallback de sistema:** `ESPEAK_BIN` + `ffmpeg`; ambos deben estar instalados para marcar TTS local disponible.
- **Fallback de navegador:** si Piper/Kokoro y el TTS de sistema no están instalados, `/robot` usa `speechSynthesis` del navegador para la demo.

## ESP32 / Red

| Parámetro | Valor |
|-----------|-------|
| WiFi SSID | `${WIFI_SSID}` |
| WiFi Password | `${WIFI_PASSWORD}` (definir en .env) |
| ESP32 WebSocket | `${ESP32_WS_URL}` o backend `:3005/ws/robot` |

## RPi5 (SSH)

| Parámetro | Valor |
|-----------|-------|
| Host | `${RPI5_HOST}` |
| Usuario | `${RPI5_USER}` |
| Password | `${RPI5_PASSWORD}` (definir en .env) |
| ROS2 Domain ID | 42 |
| RMW | rmw_cyclonedds_cpp |

## Seguridad

| Parámetro | Valor |
|-----------|-------|
| JWT Secret | `${JWT_SECRET}` (definir en .env) |

## Qué es obligatorio en cada modo

- **Solo interfaz:** no requiere claves; `npm run dev` permite revisar la navegación visual.
- **Web local completa:** requiere `POSTGRES_*`, `REDIS_*`, `CHROMA_*`, `JWT_SECRET`, `ADMIN_PASSWORD` y Docker.
- **LLM y visión cloud:** además requiere `OPENROUTER_API_KEY`.
- **Voz básica de demo:** Chrome/Edge, permiso de micrófono y audio; usa `SpeechRecognition` y `speechSynthesis` del navegador.
- **Voz avanzada:** requiere los modelos/binarios locales documentados en `TTS Local (Piper)` y `WhisperLiveKit`; no se distribuyen en este repositorio.
- **Robot físico:** requiere red, RPi5, ESP32 y ROS2 externos; este repositorio no los contiene ni los activa.

## Configuración del Restaurante

| Parámetro | Valor |
|-----------|-------|
| Nombre | Cafetería UTEC |
| Mesas | 20 configuradas en `.env.example` |
| Robot | Uchino |

## Puertos del Sistema

| Servicio | Puerto |
|----------|--------|
| API Server | 3005 |
| Grafana | 3000 |
| InfluxDB | 8086 |
| PostgreSQL | 5432 |
| Redis | 6379 |
| ChromaDB | 8000 |
| Mosquitto MQTT | 1883 |
