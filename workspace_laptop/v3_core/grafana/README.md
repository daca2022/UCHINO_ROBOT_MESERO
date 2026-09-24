# grafana

## Propósito

Configuracion de dashboards de Grafana para visualizacion en tiempo real de metricas del sistema Uchino. Muestra estado de GPU, latencia del pipeline de audio, uso de memoria, estado de servicios Docker, y metricas de negocio (pedidos, interacciones). Los dashboards se provisionan automaticamente via configuracion declarativa.

## Tecnologías

- Grafana 10.x
- InfluxDB (datasource de metricas)
- JSON (dashboards y provisioning)

## Archivos principales

- `provisioning/datasources/` — Configuracion del datasource InfluxDB
- `provisioning/dashboards/` — Configuracion de provision automatico de dashboards
- `dashboards/` — Archivos JSON de dashboards personalizados

## Interacciones

- **Lee de**: InfluxDB (puerto 8086) — metricas de tiempo enviadas por el backend y el orchestrator
- **Expone en**: Puerto 3000 — interfaz web de Grafana
- **Coordina con**: `docker/` (InfluxDB como datasource), `backend_api/` (envio de metricas)

## Puertos/Endpoints

- **3000** — Interfaz web de Grafana (http://localhost:3000)
