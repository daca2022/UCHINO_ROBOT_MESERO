# MODULO: memory_db

## Propósito
Capa de persistencia y memoria del Robot Mesero — consolida PostgreSQL (pedidos, clientes, menú), Redis (caché), y ChromaDB (memoria semántica/vectorial) en un servicio unificado con patrón repositorio.

## Archivos clave
- `src/services/MemoryService.mjs`: Servicio principal — orquesta operaciones de menú (con caché Redis TTL 5min), pedidos (CRUD + listado activos), clientes (recordar preferencias), y memoria semántica vía ChromaDB.
- `src/adapters/PostgresPedidoRepository.mjs`: Repositorio PostgreSQL para pedidos — implementa `IRepository` con operaciones CRUD, filtros por estado/mesa, paginación, y serialización JSON de platos.
- `src/ports/IRepository.mjs`: Interfaz abstracta que define el contrato para todos los repositorios (create, findById, findAll, update, delete).
- `src/index.mjs`: Exporta `MemoryService`, `PostgresPedidoRepository`.

## Cómo extender
Crear nuevos repositorios que extiendan `IRepository` para otras entidades (ej. inventario, empleados). Agregar métodos en `MemoryService` que combinen PostgreSQL + Redis + ChromaDB según la necesidad. Para nuevas consultas, agregar métodos al repositorio correspondiente con filtros dinámicos.

## Dependencias
- npm: pg (PostgreSQL), redis, chromadb
- Externos: PostgreSQL server, Redis server, ChromaDB server
- Otros módulos: backend_api (inyecta los repositorios en services.mjs)
