# Guía pública de UCHINO

Esta guía describe el camino reproducible para revisar la interfaz, levantar el backend local y distinguir las partes que requieren servicios externos. Está escrita para una instalación nueva, una demostración de tesis o una contribución al repositorio.

## 1. Qué vas a ejecutar

El arranque público recomendado levanta:

1. La interfaz web de Robot, Cocina y Administración.
2. El backend Express y su WebSocket.
3. SQLite local para operación inmediata.
4. PostgreSQL, Redis, ChromaDB, InfluxDB y Grafana mediante Docker.

No levanta automáticamente un robot físico. Tampoco incluye los modelos grandes de STT/TTS ni un entorno ROS2/RPi5. Esas piezas se conectan después, cuando existen el hardware, los modelos y sus credenciales.

## 2. Requisitos

Para el modo web local:

- Linux o WSL2 recomendado.
- Node.js 20, 22 o superior y npm.
- Docker Engine y Docker Compose v2.
- Git y `curl`.
- Al menos 4 GB de memoria libre para la infraestructura local.

Para voz o robot físico se agregan Python, los modelos de voz, ROS2 Jazzy, RPi5, ESP32, cámara y la red del robot. No son requisitos para abrir las páginas.

## 3. Instalación desde cero

Clona el repositorio y entra en la carpeta que contiene la aplicación:

```bash
git clone https://github.com/daca2022/UCHINO_ROBOT_MESERO.git
cd UCHINO_ROBOT_MESERO/workspace_laptop/v3_core
cp .env.example .env
```

Edita `.env` con un editor local. Para que Docker pueda crear todos los servicios, define valores propios para:

```dotenv
ADMIN_USER=admin
ADMIN_PASSWORD=elige-una-contraseña-local
JWT_SECRET=una-cadena-larga-y-aleatoria
VISION_MOCK=true
POSTGRES_PASSWORD=una-contraseña-local
INFLUX_TOKEN=un-token-local
GF_SECURITY_ADMIN_PASSWORD=otra-contraseña-local
```

Añade `OPENROUTER_API_KEY` solo si quieres respuestas del LLM o visión cloud. Mantén `VISION_MOCK=true` si no tienes una cámara accesible. No pegues claves en el README, en un issue ni en Git.

## 4. Arranque recomendado de la web

Desde `workspace_laptop/v3_core` ejecuta:

```bash
bash start_web.sh
```

El script instala las dependencias Node de cada módulo, compila la interfaz en `frontend_ui/dist`, inicia la infraestructura Docker, crea la carpeta SQLite si hace falta y deja el backend escuchando en el puerto 3005. Si `.env` no existe, crea una copia de `.env.example` y se detiene para que completes los secretos.

Abre estas direcciones:

| Dirección | Pantalla |
|---|---|
| `http://localhost:3005/robot` | Pedido y conversación del robot |
| `http://localhost:3005/cocina` | KDS de Cocina |
| `http://localhost:3005/admin` | Administración y métricas |
| `http://localhost:3000` | Grafana, si el contenedor está saludable |

Para probar la voz en una laptop, abre `/robot` en Chrome o Edge, concede el micrófono, selecciona una mesa cuando Administración la asigne y pulsa `Pedir por voz`. La respuesta se reproduce con el TTS local si está instalado o con la voz del navegador si no lo está.

Verifica el backend con:

```bash
curl http://localhost:3005/api/status
docker compose --env-file .env -f docker/docker-compose.infra.yml ps
```

El estado puede mostrar `degraded` cuando faltan servicios opcionales o credenciales; eso no significa que la interfaz no se haya servido. Revisa la causa en `workspace_laptop/v3_core/shared/logs/backend_v3.log`.

## 5. Credenciales: dónde van

La plantilla visible es [`workspace_laptop/v3_core/.env.example`](../workspace_laptop/v3_core/.env.example). El archivo que contiene valores reales es `workspace_laptop/v3_core/.env`, está ignorado por Git y no debe subirse. La tabla de variables está en [`CREDENTIALS.md`](../workspace_laptop/v3_core/shared/credentials/CREDENTIALS.md).

| Necesidad | Variables principales | Se necesita para |
|---|---|---|
| Panel y Cocina | `ADMIN_USER`, `ADMIN_PASSWORD`, `JWT_SECRET` | Iniciar sesión y usar acciones protegidas |
| Persistencia | `POSTGRES_*`, `REDIS_*`, `CHROMA_*` | Datos, memoria y cola completa |
| LLM/visión | `OPENROUTER_API_KEY` | Respuestas generativas y análisis cloud |
| Grafana/series | `INFLUX_*`, `GF_SECURITY_ADMIN_PASSWORD` | Métricas históricas |
| Red física | `RPI5_*`, `WIFI_*`, `ESP32_WS_URL` | Integración posterior con hardware |

En Render, las claves se introducen en el panel como variables `sync: false`; nunca se escriben en `render.yaml`.

## 6. Voz sin sorpresas: STT y TTS

La publicación tiene dos niveles de voz para que la primera ejecución no quede bloqueada por una descarga de modelos:

| Ruta | Qué usa | Qué debe hacer la persona que clona |
|---|---|---|
| STT base | `SpeechRecognition`/`webkitSpeechRecognition` del navegador | Abrir `/robot` en Chrome o Edge y aceptar el permiso del micrófono |
| TTS base | `speechSynthesis` del navegador cuando el TTS local no está listo | Permitir audio en la pestaña; no necesita una API adicional |
| STT/TTS avanzado | WhisperLiveKit + Piper/Kokoro y modelos locales | Instalar los entornos y modelos indicados en `CREDENTIALS.md` |

El texto reconocido por el navegador entra en `/api/asr/process`, el mismo contrato que usa la pantalla táctil. Si el backend detecta un reproductor TTS local listo, lo usa primero; si no, la respuesta saneada se reproduce en el navegador. Esto hace funcional el recorrido de voz de demostración sin presentar un modelo grande como si estuviera incluido.

El navegador debe ser compatible y tener permiso de micrófono. Si se necesita una ruta independiente del navegador, hay que instalar WhisperLiveKit y su modelo; no es una credencial que pueda sustituirse por una variable de `.env`.

## 7. Qué está incluido y qué requiere preparación adicional

| Componente | Estado en este repositorio | Qué falta para usarlo |
|---|---|---|
| Interfaz `/robot`, `/cocina`, `/admin` | Incluida y compilable | Nada para abrirla localmente |
| Backend y WebSocket | Incluido y verificable | Docker y `.env` para datos completos |
| PostgreSQL, Redis, ChromaDB, InfluxDB, Grafana | Definidos en Compose | Docker y credenciales locales |
| SQLite | Se crea automáticamente | Nada adicional |
| LLM OpenRouter | Integrado del lado servidor | Tu propia `OPENROUTER_API_KEY` |
| TTS Piper/Kokoro | Integración de código + fallback de navegador | Binario, modelos y entorno local para calidad avanzada; no se distribuyen |
| STT WhisperLiveKit | Integración de streaming + fallback de navegador | Clon/venv/modelo `large-v3-turbo` para modo avanzado; no se distribuyen |
| Visión | Mock disponible para demo | Cámara y clave cloud para visión real |
| ROS2/Nav2 | No forma parte de este checkout web | Workspace de navegación, RPi5 y robot |
| ESP32 | Excluido de esta publicación | Firmware y hardware externos |

Por eso una persona puede reproducir las páginas y el backend, pero no debe interpretar el clon como una imagen completa del robot físico.

## 8. Qué script usar

`start_web.sh` es el único arranque necesario para revisar la publicación web. `start_robot.sh` conserva el flujo histórico de la instalación completa y trata de iniciar sidecars de voz; requiere dependencias que no están en el clon público. `start_ui.sh` es para desarrollar o previsualizar solo Vite. `start_pln.sh`, `start_pipeline.sh` y `start_stt.sh` son servicios aislados de PLN/audio y son opcionales. `stop_robot.sh` detiene la API, el sidecar y los contenedores registrados.

Los scripts de `scripts/` son herramientas auxiliares. No ejecutes todos indiscriminadamente: cada uno tiene su propio propósito y algunos esperan una base ya migrada o un hardware concreto.

La referencia pública canónica es esta guía y el `README.md` raíz. Los `README.md`, `STATUS.md` y notas dentro de módulos describen implementación o historiales específicos; no todos son un tutorial de instalación y algunos conservan rutas de desarrollo antiguas. Para reproducir la publicación usa siempre las rutas y comandos de esta guía.

## 9. Pruebas y build

Build de la interfaz:

```bash
npm --prefix workspace_laptop/v3_core/frontend_ui ci
npm --prefix workspace_laptop/v3_core/frontend_ui run build
```

Tests Node del backend:

```bash
npm --prefix workspace_laptop/v3_core/backend_api test
```

Si una prueba necesita PostgreSQL, Redis, ChromaDB o variables de entorno, arranca primero `start_web.sh` y revisa el log. Las fallas de servicios externos deben reportarse como configuración faltante, no ocultarse eliminando tests.

En la copia pública actual, la suite histórica completa incluye casos que esperan el servicio en `localhost:3005` y un archivo de evidencia interno de Fase 13. Por eso no se presenta como una puerta verde automática del clon: en la verificación local observada quedaron 348 pruebas correctas y 5 casos dependientes de esas condiciones. El build de la interfaz y el smoke HTTP sí son reproducibles con los pasos anteriores.

## 10. Capturas de referencia

Las capturas principales están en [`docs/screenshots`](screenshots): `robot-live.png` muestra el WebSocket conectado, `cocina-live.png` una cola autenticada sin pedidos y `admin-live.png` el dashboard protegido. Sus variantes `*-live-mobile.png` documentan la vista estrecha. Las imágenes sin el sufijo `-live` se conservan como estados de diagnóstico o acceso inicial.

La sesión que produjo las capturas fue local y no demuestra por sí sola que un robot físico, un dominio cloud o un modelo Whisper estén disponibles. La diferencia está escrita en cada sección para que una captura nunca se confunda con aceptación de hardware.

## 11. Publicación cloud

`render.yaml` describe un servicio Node que construye la interfaz y arranca `backend_api/src/server.mjs`. Para una demo cloud:

1. Crea el servicio desde el repositorio GitHub.
2. Configura las variables `sync: false` en Render: `ADMIN_PASSWORD`, `JWT_SECRET`, `OPENROUTER_API_KEY` y las conexiones de datos que realmente vayas a usar.
3. Usa PostgreSQL, Redis y ChromaDB administrados o servicios compatibles; no dependas de `localhost` en producción.
4. Deja `VISION_MOCK=true` mientras no exista una cámara accesible al servicio.
5. Comprueba `/api/status` y las tres rutas antes de compartir el enlace.

La publicación está preparada para esa ruta, pero no afirma que las bases administradas, el dominio, los secretos o un robot real ya estén contratados. La página cloud y el robot físico son entregas separadas.

## 12. Para reproducir la tesis

Conserva la versión de Node, las variables usadas y la salida de `curl /api/status` junto a la fecha de la prueba. Para una demostración reproducible, indica si el caso usa LLM real o mock, si TTS/STT están instalados y si la navegación es simulada. Esa distinción evita presentar una captura estática como aceptación de hardware.

Si reutilizas el software en una tesis o curso, usa la referencia de [`CITATION.cff`](../CITATION.cff) y conserva la versión del commit.
