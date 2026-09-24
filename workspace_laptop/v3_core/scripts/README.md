# scripts

## Propósito

Coleccion de scripts Bash de utilidad para configuracion, mantenimiento y operaciones del sistema Uchino. Scripts de arranque, monitoreo, descarga de modelos y setup de hardware. Los scripts Python de prueba de audio y el schema SQL se movieron a `pruebas/python/scripts/` y `memory_db/` respectivamente.

## Tecnologías

- Bash (scripts de automatizacion)
- Python 3.12 (scripts de servicio)
- SQL (inicializacion de base de datos)

## Archivos principales

- `iniciar_chipi.sh` — Arranque granular del robot (Docker, pipeline, STT, backend, orchestrator)
- `ver_logs.sh` — Visualizacion unificada de logs
- `estado.sh` — Health check rapido de todos los servicios
- `download_qwen3.sh` — Descarga del modelo Qwen para Ollama
- `setup_piper_model.sh` — Setup de modelos Piper TTS
- `setup_rpi5.sh` — Configuracion inicial de la Raspberry Pi 5
- `enable_nat_rpi5.sh` — Configuracion de red NAT para Raspberry Pi 5

## Interacciones

- **Configura**: Modelos (`download_qwen3.sh`, `setup_piper_model.sh`), red (`enable_nat_rpi5.sh`), hardware (`setup_rpi5.sh`)
- **Arranca**: Servicios del robot (`iniciar_chipi.sh`)
- **Monitorea**: Logs (`ver_logs.sh`) y estado (`estado.sh`)
- **No es codigo de runtime**: Son herramientas de setup, arranque y mantenimiento
