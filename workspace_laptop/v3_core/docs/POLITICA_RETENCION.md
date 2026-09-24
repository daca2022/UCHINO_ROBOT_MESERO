# Política de Retención de Datos

**Proyecto:** Robot Mesero UTEC (Uchino)
**Versión:** 1.0
**Fecha:** 2026-06-02
**Estado:** Activa

---

## Propósito

Esta política define cuánto tiempo se conservan los distintos tipos de archivos y directorios del proyecto, quién puede acceder a ellos, y bajo qué condiciones se pueden eliminar.

---

## A) `archive/` — Versiones Legacy

| Campo | Detalle |
|---|---|
| **Ubicación** | `chipi_workspace_pln/archive/` |
| **Propósito** | Conservar código histórico de versiones anteriores (v1 Node-RED, v2 OpenClaw, robot_mesero_final, scripts_rotos). |
| **Retención** | **PERMANENTE.** No eliminar sin aprobación explícita del equipo. |
| **Acceso** | Solo lectura. **NUNCA** modificar archivos dentro de `archive/`. |
| **Revisión** | Anual. Evaluar si cada subdirectorio sigue siendo relevante o si puede migrarse a un repositorio separado de archivo histórico. |

### Subdirectorios actuales

| Directorio | Contenido |
|---|---|
| `v1_nodered/` | Sistema original basado en Node-RED |
| `v2_openclaw/` | Integración con OpenClaw + vLLM Hermes |
| `robot_mesero_final/` | Cascarón V2 con plan de migración |
| `scripts_rotos/` | Scripts con rutas rotas (referencia histórica) |
| `old_repos/` | Repositorios antiguos |

---

## B) `.sisyphus/` — Notas y Planes del Agente AI

| Campo | Detalle |
|---|---|
| **Ubicación** | `chipi_workspace_pln/.sisyphus/` |
| **Propósito** | Conservar planes de trabajo, notas de sesión y evidencia de QA generados por el agente AI. |
| **Acceso** | Lectura/escritura por el agente. Los humanos pueden consultar pero no modificar directamente. |

### Subdirectorios y retención

| Subdirectorio | Contenido | Retención | Acción al vencer |
|---|---|---|---|
| `plans/` | Planes de trabajo (archivos `.md`) | **PERMANENTE** | No eliminar. Son historia del proyecto. |
| `evidence/` | Screenshots, logs y resultados de QA | **30 días** | Eliminar mensualmente archivos con antigüedad mayor a 30 días. |
| `notepads/` | Notas de sesión del agente | **90 días** | Archivar o eliminar trimestralmente notas con antigüedad mayor a 90 días. |
| `drafts/` | Borradores de planes en progreso | **30 días** | Eliminar si no se convirtieron en planes formales. |
| `boulder.json` | Estado interno de continuación | **Mantener** | No eliminar. Archivo de control del agente. |
| `run-continuation/` | Control de ejecución continuada | **Mantener** | No eliminar. Archivo de control del agente. |

---

## C) `pruebas/` — Tests y Demos

| Campo | Detalle |
|---|---|
| **Ubicación** | `chipi_workspace_pln/v3_core/pruebas/` |
| **Propósito** | Centralizar todo el código de prueba, demos y prototipos del sistema v3. |
| **Retención** | **PERMANENTE.** Los tests son parte del activo del proyecto. |
| **Eliminación** | **NUNCA** eliminar un test sin reemplazarlo o documentar por qué se eliminó. |

### Subdirectorios actuales

| Directorio | Contenido |
|---|---|
| `nodejs/` | Tests del backend API (Node.js) |
| `python/` | Tests de módulos Python (diálogo, orchestrator, wake word, etc.) |
| `frontend/` | Tests y páginas de prueba del frontend |
| `demos/` | Demos y prototipos funcionales |

---

## D) Regla General

Para cualquier archivo o directorio que no esté cubierto explícitamente por esta política:

1. **Código activo** (`v3_core/`): Se gestiona mediante git. Cada commit es un punto de recuperación.
2. **Credenciales**: NUNCA commitear. Solo en `.env` (que está en `.gitignore`).
3. **Binarios grandes**: No commitear al repositorio. Usar almacenamiento externo si es necesario.
4. **Logs**: Los logs en `shared/logs/` se pueden rotar y eliminar después de 7 días.
5. **Build artifacts**: El contenido de `dist/` se regenera con `npm run build`. No necesita retención especial.
6. **`node_modules/`**: Nunca commitear. Se regenera con `npm install`.
7. **Modelos y checkpoints**: Los archivos en `models/` y `wav2vec2_checkpoints/` son grandes pero necesarios. No eliminar sin verificar que se pueden re-descargar.

---

## Resumen de Retención

| Tipo | Retención | Revisión |
|---|---|---|
| `archive/` | Permanente | Anual |
| `.sisyphus/plans/` | Permanente | No aplica |
| `.sisyphus/evidence/` | 30 días | Mensual |
| `.sisyphus/notepads/` | 90 días | Trimestral |
| `.sisyphus/drafts/` | 30 días | Mensual |
| `pruebas/` | Permanente | No aplica |
| `shared/logs/` | 7 días | Semanal |
| Código activo (`v3_core/`) | Git (indefinido) | Por commit |

---

## Historial de Cambios

| Versión | Fecha | Cambio |
|---|---|---|
| 1.0 | 2026-06-02 | Creación inicial de la política |
