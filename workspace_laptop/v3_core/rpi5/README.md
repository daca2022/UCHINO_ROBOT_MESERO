# rpi5

## Propósito

Scripts y configuraciones para la Raspberry Pi 5 que funciona como kiosk de vision y pantalla del robot. Incluye el servicio systemd para arranque automatico del kiosk, el script de inicio que lanza el frontend y la captura de video de la camara RGB Logitech Brio, y el script de arranque de ROS2 para los nodos de navegacion.

## Tecnologías

- Bash (scripts de inicio)
- systemd (servicio de kiosk)
- ROS2 Jazzy (nodos de robot)

## Archivos principales

- `kiosk_start.sh` — Script de inicio del kiosk (frontend + vision)
- `chipi-kiosk.service` — Unidad systemd para arranque automatico
- `start_ros2.sh` — Script de arranque de nodos ROS2

## Interacciones

- **Ejecuta en**: Raspberry Pi 5 (IP configurada en `.env`)
- **Se comunica con**: Laptop principal via red (WebSocket al backend en :3005, ROS2 DDS con `ROS_DOMAIN_ID=42`)
- **Controla**: Camara RGB Logitech Brio (puerto 8765 para captura HTTP), pantalla tactil de 7"
