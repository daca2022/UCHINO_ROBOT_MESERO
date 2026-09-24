# shared

## Propósito

Directorio centralizado para recursos compartidos entre todos los modulos del sistema. Contiene las credenciales (solo nombres de variables, nunca valores), logs de ejecucion de todos los componentes, y screenshots generados durante la operacion del robot.

## Tecnologías

- Markdown (documentacion de credenciales)
- Logs de texto plano

## Archivos principales

- `credentials/CREDENTIALS.md` — Lista de variables de entorno requeridas (sin valores)
- `logs/backend_v3.log` — Log principal del backend v3
- `logs/backend.log` — Log legacy del backend

## Interacciones

- **Lee de**: Todos los modulos leen `CREDENTIALS.md` para saber que variables necesita
- **Escribe en**: `backend_api/`, `orchestrator/`, y otros modulos escriben logs aqui
- **Referencia**: `.env` en la raiz de `v3_core/` es la unica fuente de valores reales
