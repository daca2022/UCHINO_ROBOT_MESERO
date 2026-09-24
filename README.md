# UCHINO Robot Mesero

Publicación reproducible del PLN y la interfaz web del robot mesero UCHINO.

## Contenido

- `workspace_laptop/v3_core/frontend_ui`: interfaces `/robot`, `/cocina` y `/admin`.
- `workspace_laptop/v3_core/backend_api`: API Express, WebSocket y servicios de negocio.
- `workspace_laptop/v3_core/memory_db`: migraciones y servicios de memoria.
- `workspace_laptop/v3_core/orchestrator`, `dialogue` y `pln`: orquestación y diálogo.
- `render.yaml`: configuración de despliegue del servicio web.

Los modelos pesados, credenciales, archivos `.env`, hardware y artefactos de compilación no se versionan en esta publicación. Usa `workspace_laptop/v3_core/.env.example` y `workspace_laptop/v3_core/shared/credentials/CREDENTIALS.md` como referencia de configuración.

## Desarrollo local

```bash
cd workspace_laptop/v3_core/frontend_ui
npm install
npm run build

cd ../
bash start_robot.sh
```

El backend sirve `/robot`, `/cocina` y `/admin` en el puerto `3005` cuando la configuración local está completa.
