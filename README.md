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

## Qué puede hacer otra persona al clonarlo

Con Node.js 20/22 puede instalar y compilar la interfaz sin recibir ninguna clave:

```bash
cd workspace_laptop/v3_core/frontend_ui
npm ci
npm run build
```

Eso genera las páginas web. Para una vista visual puede ejecutar después `npm run dev`, pero los botones que consultan datos necesitan el backend. Para que las páginas hablen con el backend y guarden pedidos necesita levantar la infraestructura local y el backend:

```bash
cd ..
cp .env.example .env
# Editar .env con valores propios; nunca copiar claves desde este repositorio.
bash start_robot.sh
```

Sin `OPENROUTER_API_KEY`, la interfaz y las rutas determinísticas pueden abrirse, pero las respuestas del LLM y la visión cloud no estarán disponibles. Sin PostgreSQL, Redis y ChromaDB, las funciones de memoria, analítica y persistencia no estarán completas. La navegación real no se activa: este repositorio usa el modo de simulación y no contiene el robot físico.

En otras palabras: el clon trae el código y puede construir la UI, pero no trae servicios de datos ni una API compartida. Cada persona debe levantar Docker y usar sus propias credenciales para obtener una instalación local completa.

## Credenciales y API

- `OPENROUTER_API_KEY` es la clave personal del usuario para el LLM. Se lee únicamente en el backend mediante `process.env`; no se envía al navegador ni se guarda en GitHub.
- `ADMIN_USER`, `ADMIN_PASSWORD` y `JWT_SECRET` protegen `/admin`. El usuario inicial recomendado es `admin`, con una contraseña propia.
- `POSTGRES_*`, `REDIS_*`, `CHROMA_*` e `INFLUX_*` apuntan a servicios locales o administrados por quien despliega.
- En Render, `render.yaml` declara las variables sensibles con `sync: false`; el propietario las introduce en el panel de Render. El repositorio no contiene ninguna clave real.
