# MODULO: ros2_control

## Propósito
Puente de control ROS2 del Robot Mesero — gestiona la navegación del robot (recorridos cocina → mesa → base), expone interfaces para comandos del robot y telemetría, y reemplaza la lógica de tab_recorrido de Node-RED.

## Archivos clave
- `src/services/RecorridoService.mjs`: Servicio principal — gestiona recorridos completos con etapas (cocina → utensilios → bebidas → mesa → base), avance por etapas, progreso, cancelación con retorno a base, e historial de recorridos.
- `src/ports/IRobotCommand.mjs`: Interfaz abstracta para comandos del robot (mover a lugar, detener, etc.).
- `src/ports/ITelemetry.mjs`: Interfaz abstracta para telemetría (batería, posición, estado).
- `src/index.mjs`: Punto de entrada — exporta `IRobotCommand`, `ITelemetry`, `RecorridoService`.
- `src/adapters/`: Adaptadores concretos que implementan los puertos (conexión ROS2 real o mock).
- `src/topics/`: Definiciones de tópicos ROS2 y mensajes.

## Cómo extender
Implementar adaptadores concretos para `IRobotCommand` e `ITelemetry` que se comuniquen con ROS2 vía rosbridge o rclpy. Para nuevos recorridos, modificar las etapas en `RecorridoService` o crear servicios adicionales. Agregar nuevos tópicos en `src/topics/` según necesidad.

## Dependencias
- npm: ws (WebSocket para rosbridge), mqtt (opcional)
- Externos: ROS2 Jazzy corriendo con rosbridge_server o rclpy disponible
- Otros módulos: backend_api (inyecta RecorridoService en services.mjs)
