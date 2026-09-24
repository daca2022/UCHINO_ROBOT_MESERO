# UCHINO Robot Mesero

Publicación reproducible del PLN y la interfaz web del robot mesero UCHINO.

La ruta técnica `workspace_laptop/v3_core` se conserva para que los imports y los scripts sigan funcionando; la tabla siguiente da el nombre claro de cada módulo.

## Mapa de la publicación

| Ruta | Nombre entendible | Función |
|---|---|---|
| `workspace_laptop/v3_core/frontend_ui` | Interfaz web | Páginas `/robot`, `/cocina` y `/admin` |
| `workspace_laptop/v3_core/backend_api` | Backend y API | Express, WebSocket y reglas de negocio |
| `workspace_laptop/v3_core/memory_db` | Memoria y PostgreSQL | Migraciones y repositorios |
| `workspace_laptop/v3_core/orchestrator` | Orquestador | FastAPI y coordinación del diálogo |
| `workspace_laptop/v3_core/dialogue` | Diálogo | Estados conversacionales y clientes LLM |
| `workspace_laptop/v3_core/pln` | Lenguaje natural | Intenciones y extracción de pedidos |
| `workspace_laptop/v3_core/ros2_control` | Integración ROS2 | Contratos de recorrido, sin hardware incluido |
| `workspace_laptop/v3_core/docker` | Infraestructura | PostgreSQL, Redis, ChromaDB, Grafana e InfluxDB |
| `render.yaml` | Despliegue cloud | Servicio web para Render |

Esta es la publicación **PLN/web**, no el workspace completo del robot. No incluye navegación física, firmware ESP32, archivos de `archive`, checkpoints de modelos, credenciales ni artefactos de compilación.

Usa `workspace_laptop/v3_core/.env.example` y `workspace_laptop/v3_core/shared/credentials/CREDENTIALS.md` como referencia de configuración. Las claves reales solo se agregan como secretos del proveedor de despliegue.

## Desarrollo local

```bash
cd workspace_laptop/v3_core/frontend_ui
npm install
npm run build

cd ..
bash start_robot.sh
```

El backend sirve `/robot`, `/cocina` y `/admin` en el puerto `3005` cuando la configuración local está completa.
