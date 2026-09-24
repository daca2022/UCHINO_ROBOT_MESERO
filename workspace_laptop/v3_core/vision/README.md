# vision

## Propósito

Gestiona la captura y analisis de imagenes de una camara RGB USB en la Raspberry Pi 5. El hardware final previsto es Logitech Brio, complementado por LiDAR 2D para navegacion, encoders de rueda, sensor de flujo optico PMW3901 e IMU BNO. El nodo de captura expone un servidor HTTP para obtener frames, el manager coordina el envio de imagenes al cascade de vision (Qwen3 VL 8B describe → DeepSeek V4 Flash refina via OpenRouter), y el execution_checker valida acciones del robot cuando corresponde.

## Tecnologías

- Python 3.12 (nodo de captura HTTP)
- Node.js (vision manager)
- OpenRouter API (Qwen3 VL 8B visión + DeepSeek V4 Flash refinamiento)

## Archivos principales

- `vision_capture_node.py` — Nodo Python que captura frames de la camara RGB y los sirve via HTTP
- `vision_manager.mjs` — Gestor Node.js que envia imagenes al LLM para analisis
- `execution_checker.py` — Validador de seguridad antes de ejecutar acciones del robot

## Interacciones

- **Captura de**: Camara RGB Logitech Brio en RPi5 (puerto 8765)
- **Envia a**: Cascade visión (Qwen3 VL 8B describe → DeepSeek V4 Flash refina) via OpenRouter
- **Coordina con**: `orchestrator/` (solicitudes de vision), `ros2_control/` (acciones del robot validadas por execution_checker), `llm_brain/` (cliente de vision)

## Puertos/Endpoints

- **8765** — Servidor HTTP de captura de vision (RPi5)

## Topico de camara

Por defecto el nodo escucha:

```text
/camera/image_raw
```

Se puede cambiar sin modificar codigo:

```bash
export VISION_CAMERA_TOPIC=/camera/image_raw
```
