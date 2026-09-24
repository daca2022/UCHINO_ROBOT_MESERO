# docker

## Propósito

Define la infraestructura de contenedores Docker que soporta el sistema Uchino. Incluye PostgreSQL (datos persistentes), Redis (cache y pub/sub), ChromaDB (vectores para memoria semantica), InfluxDB (metricas de tiempo) y Grafana (visualizacion de dashboards).

## Tecnologías

- Docker Compose
- PostgreSQL 16
- Redis 7
- ChromaDB
- InfluxDB 2.x
- Grafana 10.x

## Archivos principales

- `docker-compose.infra.yml` — Definicion de todos los servicios de infraestructura

## Interacciones

- **Provee servicios a**: `backend_api/` (PostgreSQL, Redis), `memory_db/` (ChromaDB, PostgreSQL), `memory/` (ChromaDB, sentence-transformers), `grafana/` (InfluxDB como datasource)
- **Todos los servicios** comparten la red Docker definida en el compose

## Puertos/Endpoints

- **5432** — PostgreSQL
- **6379** — Redis
- **8000** — ChromaDB
- **8086** — InfluxDB
- **3000** — Grafana
