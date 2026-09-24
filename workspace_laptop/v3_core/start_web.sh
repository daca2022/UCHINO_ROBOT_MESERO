#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

PORT="${PORT:-3005}"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Se creó .env desde .env.example. Completa ADMIN_PASSWORD y JWT_SECRET antes de continuar."
  exit 2
fi

set -a
source .env
set +a
PORT="${PORT:-3005}"

required_vars=(ADMIN_PASSWORD JWT_SECRET POSTGRES_PASSWORD INFLUX_TOKEN GF_SECURITY_ADMIN_PASSWORD)
missing_vars=()
for variable in "${required_vars[@]}"; do
  [ -n "${!variable:-}" ] || missing_vars+=("$variable")
done
if [ "${#missing_vars[@]}" -gt 0 ]; then
  echo "Completa estas variables en .env antes de iniciar la infraestructura: ${missing_vars[*]}"
  exit 2
fi

command -v docker >/dev/null 2>&1 || { echo "Docker no está instalado."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js no está instalado."; exit 1; }
node_major="$(node -p "process.versions.node.split('.')[0]")"
[ "$node_major" -ge 20 ] || { echo "Se requiere Node.js 20 o superior."; exit 1; }

echo "[1/4] Instalando dependencias Node..."
npm --prefix memory_db ci
npm --prefix ros2_control ci
npm --prefix backend_api ci
npm --prefix frontend_ui ci
npm --prefix frontend_ui run build

echo "[2/4] Levantando PostgreSQL, Redis, ChromaDB, InfluxDB y Grafana..."
docker compose --env-file .env -f docker/docker-compose.infra.yml up -d

mkdir -p shared/logs

if curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
  echo "[3/4] Backend ya estaba activo en http://localhost:${PORT}."
else
  echo "[3/4] Iniciando backend en http://localhost:${PORT}..."
  nohup env PORT="$PORT" node backend_api/src/server.mjs > shared/logs/backend_v3.log 2>&1 &
  echo $! > .backend.pid
  for _ in $(seq 1 30); do
    curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1 && break
    sleep 1
  done
fi

if ! curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
  echo "El backend no respondió; revisa shared/logs/backend_v3.log."
  exit 1
fi

echo "[4/4] Sistema web listo:"
echo "  Robot:  http://localhost:${PORT}/robot"
echo "  Cocina: http://localhost:${PORT}/cocina"
echo "  Admin:  http://localhost:${PORT}/admin"
echo "  Estado: curl http://localhost:${PORT}/api/status"
echo "Para detener API e infraestructura: bash stop_robot.sh"
