#!/bin/bash
# ═══════════════════════════════════════════════════════════
# start_robot.sh — Inicializacion profesional Robot Mesero
# ═══════════════════════════════════════════════════════════
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

listener_pid() {
    local port="$1"
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

start_audio_service_if_missing() {
    local name="$1"
    local port="$2"
    local script="$3"
    local pid_file="$4"
    local existing_pid
    existing_pid="$(listener_pid "$port")"
    if [ -n "$existing_pid" ]; then
        echo -e "   ${GREEN}✅ $name ya está activo (PID $existing_pid, puerto $port); se reutiliza${NC}"
        echo "$existing_pid" > "$pid_file"
        return 0
    fi

    nohup bash "$script" > "shared/logs/${name}.log" 2>&1 &
    local pid=$!
    echo "$pid" > "$pid_file"
    echo -e "   ${GREEN}✅ $name iniciado (PID $pid, puerto $port)${NC}"
}

echo -e "${GREEN}🤖 Robot Mesero Uchino — Inicializacion Profesional${NC}"
echo "═══════════════════════════════════════════════════════"

# ── 1. Verificar dependencias ──────────────────────────────
echo -e "\n${YELLOW}[1/8] Verificando dependencias...${NC}"
command -v docker >/dev/null 2>&1 || { echo -e "${RED}❌ Docker no instalado${NC}"; exit 1; }
command -v node >/dev/null 2>&1 || { echo -e "${RED}❌ Node.js no instalado${NC}"; exit 1; }
node -v | grep -E "v2[0-9]" >/dev/null || { echo -e "${RED}❌ Node.js >= 20 requerido${NC}"; exit 1; }
echo -e "${GREEN}✅ Docker + Node.js OK${NC}"

# ── 2. Infraestructura Docker ──────────────────────────────
echo -e "\n${YELLOW}[2/8] Levantando infraestructura de datos...${NC}"
docker compose --env-file .env -f docker/docker-compose.infra.yml up -d

# ── 3. Esperar healthchecks ────────────────────────────────
echo -e "\n${YELLOW}[3/8] Esperando bases de datos...${NC}"
echo "   ⏳ PostgreSQL..."
until docker exec chipi_postgres pg_isready -U chipi >/dev/null 2>&1; do sleep 1; done
echo -e "   ${GREEN}✅ PostgreSQL${NC}"

echo "   ⏳ Redis..."
until docker exec chipi_redis redis-cli ping | grep -q PONG; do sleep 1; done
echo -e "   ${GREEN}✅ Redis${NC}"

echo "   ⏳ ChromaDB..."
until curl -s http://localhost:8000/api/v1/heartbeat >/dev/null 2>&1; do sleep 1; done
echo -e "   ${GREEN}✅ ChromaDB${NC}"

echo "   ⏳ InfluxDB..."
influx_tries=0
until curl -sf http://localhost:8086/health >/dev/null 2>&1 || [ $influx_tries -eq 15 ]; do sleep 1; influx_tries=$((influx_tries+1)); done
if [ $influx_tries -lt 15 ]; then echo -e "   ${GREEN}✅ InfluxDB${NC}"; else echo -e "   ${YELLOW}⚠️  InfluxDB timeout${NC}"; fi

# ── 4. SQLite (archivo local) ──────────────────────────────
echo -e "\n${YELLOW}[4/8] Verificando SQLite local...${NC}"
mkdir -p data
if [ ! -f data/robot_mesero.db ]; then
    echo "   📝 Creando base SQLite nueva..."
    touch data/robot_mesero.db
fi
echo -e "   ${GREEN}✅ SQLite: data/robot_mesero.db${NC}"

# ── 5. Variables de entorno ────────────────────────────────
echo -e "\n${YELLOW}[5/8] Verificando variables de entorno...${NC}"
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  Creando .env placeholder...${NC}"
    echo -e "${RED}   ⚠️  COPIA credenciales reales desde el gestor seguro${NC}"
    cat > .env << 'EOF'
# ═══════════════════════════════════════════════════════════
# 🤖 ROBOT MESERO UTEC — Variables de entorno
# ═══════════════════════════════════════════════════════════
# GENERADO AUTOMÁTICAMENTE — reemplazar placeholders con valores reales
# Ver: shared/credentials/CREDENTIALS.md (referencias a variables de entorno)
# ═══════════════════════════════════════════════════════════

NODE_ENV=development
PORT=3005

# Bases de datos
SQLITE_PATH=./data/robot_mesero.db
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=chipi
POSTGRES_PASSWORD=CHANGE_ME
POSTGRES_DB=robot_mesero
REDIS_HOST=localhost
REDIS_PORT=6379
CHROMA_HOST=localhost
CHROMA_PORT=8000
INFLUX_URL=http://localhost:8086
INFLUX_TOKEN=CHANGE_ME
INFLUX_ORG=utec
INFLUX_BUCKET=robot_telemetry

# LLM
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
OPENROUTER_MODEL=${OPENROUTER_MODEL:-deepseek/deepseek-v4-flash}
OPENROUTER_FALLBACK_MODEL=${OPENROUTER_FALLBACK_MODEL:-meta-llama/llama-3.1-8b-instruct}

# ROS2
ROS2_DOMAIN_ID=42
FOXGLOVE_BRIDGE_WS=ws://localhost:8765

# Seguridad
JWT_SECRET=CHANGE_ME
EOF
    echo -e "${YELLOW}   ⚠️  Configura manualmente: POSTGRES_PASSWORD, INFLUX_TOKEN, JWT_SECRET${NC}"
    echo -e "${YELLOW}   ⚠️  Configura: OPENROUTER_API_KEY y WIFI_PASSWORD${NC}"
fi
echo -e "   ${GREEN}✅ .env configurado${NC}"

# ── 6. Python Orchestrator Sidecar ──────────────────────────
echo -e "\n${YELLOW}[6/8] Iniciando Orchestrator Sidecar (Python)...${NC}"
source .env 2>/dev/null || true
mkdir -p shared/logs
ORCHESTRATOR_PORT=8100
if curl -sf http://127.0.0.1:$ORCHESTRATOR_PORT/health >/dev/null 2>&1; then
    ORCH_PID="$(listener_pid "$ORCHESTRATOR_PORT")"
    echo "$ORCH_PID" > .orchestrator.pid
    echo -e "   ${GREEN}✅ Orchestrator health OK; se reutiliza (PID ${ORCH_PID:-desconocido})${NC}"
elif [ -n "$(listener_pid "$ORCHESTRATOR_PORT")" ]; then
    echo -e "   ${YELLOW}⚠️  Puerto $ORCHESTRATOR_PORT ocupado por un proceso no saludable; no se crea un duplicado${NC}"
else
    python3 -c "import fastapi, uvicorn" 2>/dev/null && {
        nohup python3 -m uvicorn orchestrator.server:app \
            --host 127.0.0.1 --port $ORCHESTRATOR_PORT \
            --log-level info \
            > shared/logs/orchestrator.log 2>&1 &
        ORCH_PID=$!
        echo $ORCH_PID > .orchestrator.pid
        echo -e "   ${GREEN}✅ Orchestrator PID $ORCH_PID (puerto $ORCHESTRATOR_PORT)${NC}"
        sleep 2
        curl -sf http://127.0.0.1:$ORCHESTRATOR_PORT/health >/dev/null 2>&1 && \
            echo -e "   ${GREEN}✅ Orchestrator health OK${NC}" || \
            echo -e "   ${YELLOW}⚠️  Orchestrator health check falló (iniciando aún?)${NC}"
    } || {
        echo -e "   ${YELLOW}⚠️  fastapi/uvicorn no disponible — omitiendo sidecar${NC}"
        echo -e "   ${YELLOW}   pip install fastapi uvicorn${NC}"
    }
fi
cd "$SCRIPT_DIR"

# ── 7. Backend API ─────────────────────────────────────────
echo -e "\n${YELLOW}[7/8] Iniciando Backend API...${NC}"
echo "   📦 Exportando variables de entorno desde .env..."
set -a; source .env; set +a
echo -e "   ${GREEN}✅ Variables cargadas${NC}"

if curl -sf "http://localhost:${PORT:-3005}/api/status" >/dev/null 2>&1; then
    BACKEND_PID="$(listener_pid "${PORT:-3005}")"
    echo "$BACKEND_PID" > .backend.pid
    echo -e "   ${GREEN}✅ Backend API ya está saludable; se reutiliza (PID ${BACKEND_PID:-desconocido})${NC}"
elif [ -n "$(listener_pid "${PORT:-3005}")" ]; then
    echo -e "   ${YELLOW}⚠️  Puerto ${PORT:-3005} ocupado por un proceso no saludable; no se crea un duplicado${NC}"
else
    echo "   📦 Instalando dependencias..."
    npm --prefix memory_db ci 2>/dev/null || true
    npm --prefix ros2_control ci 2>/dev/null || true
    cd backend_api && npm ci 2>/dev/null || true

    echo "   🧪 Ejecutando tests..."
    npm test 2>/dev/null || echo -e "${YELLOW}   ⚠️  Algunos tests pueden necesitar DB${NC}"

    echo "   🚀 Iniciando servidor..."
    nohup node src/server.mjs > ../shared/logs/backend_v3.log 2>&1 &
    BACKEND_PID=$!
    echo $BACKEND_PID > ../.backend.pid
    cd ..

    sleep 2
    if kill -0 $BACKEND_PID 2>/dev/null; then
        echo -e "   ${GREEN}✅ Backend PID $BACKEND_PID${NC}"
    else
        echo -e "${RED}   ❌ Backend fallo al iniciar${NC}"
        exit 1
    fi
fi

echo -e "\n${YELLOW}Iniciando servicios de audio requeridos...${NC}"
start_audio_service_if_missing "stt" 8002 "$SCRIPT_DIR/start_stt.sh" "$SCRIPT_DIR/.stt.pid"
start_audio_service_if_missing "pipeline" 8001 "$SCRIPT_DIR/start_pipeline.sh" "$SCRIPT_DIR/.pipeline.pid"

# ── 8. Verificacion final ──────────────────────────────────
echo -e "\n${YELLOW}[8/8] Verificacion de servicios...${NC}"
services_ok=true

curl -sf "http://localhost:${PORT:-3005}/api/status" >/dev/null 2>&1 && \
    echo -e "   ${GREEN}✅ Backend API http://localhost:${PORT:-3005}${NC}" || \
    { echo -e "   ${RED}❌ Backend API${NC}"; services_ok=false; }

if [ -f .orchestrator.pid ]; then
    ORCH_PID=$(cat .orchestrator.pid)
    if kill -0 $ORCH_PID 2>/dev/null; then
        echo -e "   ${GREEN}✅ Orchestrator sidecar (PID $ORCH_PID)${NC}"
    else
        echo -e "   ${YELLOW}⚠️  Orchestrator sidecar caído${NC}"
    fi
fi

if [ -n "$(listener_pid 8001)" ]; then
    echo -e "   ${GREEN}✅ Audio pipeline :8001${NC}"
else
    echo -e "   ${RED}❌ Audio pipeline :8001${NC}"
    services_ok=false
fi

if [ -n "$(listener_pid 8002)" ]; then
    echo -e "   ${GREEN}✅ WhisperLiveKit STT :8002${NC}"
else
    echo -e "   ${RED}❌ WhisperLiveKit STT :8002${NC}"
    services_ok=false
fi

curl -sf http://localhost:${PORT:-3005}/api/tts/status >/dev/null 2>&1 && \
    echo -e "   ${GREEN}✅ TTS status${NC}" || \
    { echo -e "   ${RED}❌ TTS status${NC}"; services_ok=false; }

curl -sf http://localhost:3000/login >/dev/null 2>&1 && \
    echo -e "   ${GREEN}✅ Grafana http://localhost:3000${NC}" || \
    echo -e "   ${YELLOW}⚠️  Grafana (puede tardar)${NC}"

# ── Resumen ────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
if [ "$services_ok" = true ]; then
    echo -e "${GREEN}🚀 Robot Mesero OPERATIVO${NC}"
else
    echo -e "${YELLOW}⚠️  Algunos servicios no respondieron (revisar logs)${NC}"
fi
echo ""
echo "Endpoints:"
echo "  API:      http://localhost:${PORT:-3005}"
echo "  Grafana:  http://localhost:3000 (admin/utec2026)"
echo "  ChromaDB: http://localhost:8000"
echo "  InfluxDB: http://localhost:8086"
echo ""
echo "Logs: tail -f shared/logs/backend_v3.log"
echo "Stop: kill \$(cat .backend.pid) && docker compose --env-file .env -f docker/docker-compose.infra.yml down"
