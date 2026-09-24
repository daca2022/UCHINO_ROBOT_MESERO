#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# iniciar_chipi.sh — Arranque granular del Robot Mesero Uchino
# ═══════════════════════════════════════════════════════════════
# Uso:
#   bash scripts/iniciar_chipi.sh --full          # Todo
#   bash scripts/iniciar_chipi.sh --infra          # Solo Docker
#   bash scripts/iniciar_chipi.sh --pipeline       # Audio :8001
#   bash scripts/iniciar_chipi.sh --stt            # STT :8002
#   bash scripts/iniciar_chipi.sh --backend        # API :3005
#   bash scripts/iniciar_chipi.sh --orchestrator   # Sidecar :8100
#   bash scripts/iniciar_chipi.sh --ayuda          # Esta ayuda
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ─── Colores ANSI ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ─── Directorio base (v3_core) ────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$SCRIPT_DIR"

# ─── Variables por defecto ─────────────────────────────────────
DO_INFRA=false
DO_PIPELINE=false
DO_STT=false
DO_BACKEND=false
DO_ORCHESTRATOR=false

# ─── Ayuda ─────────────────────────────────────────────────────
mostrar_ayuda() {
    echo -e "${CYAN}Uso:${NC} bash scripts/iniciar_chipi.sh [OPCIONES]"
    echo ""
    echo "Opciones:"
    echo "  --full          Arrancar todos los servicios"
    echo "  --infra         Solo infraestructura Docker (PostgreSQL, Redis, ChromaDB, InfluxDB, Grafana)"
    echo "  --pipeline      Solo audio pipeline (Wake Word + DeepFilterNet3 + SER proxy) :8001"
    echo "  --stt           Solo WhisperLiveKit STT :8002"
    echo "  --backend       Solo backend API Node.js :3005"
    echo "  --orchestrator  Solo orchestrador sidecar Python :8100"
    echo "  --ayuda         Mostrar esta ayuda"
    echo ""
    echo -e "${YELLOW}Ejemplos:${NC}"
    echo "  bash scripts/iniciar_chipi.sh --full"
    echo "  bash scripts/iniciar_chipi.sh --infra --backend"
    echo "  bash scripts/iniciar_chipi.sh --stt --pipeline"
    exit 0
}

# ─── Parsear argumentos ────────────────────────────────────────
if [ $# -eq 0 ]; then
    mostrar_ayuda
fi

for arg in "$@"; do
    case "$arg" in
        --full)
            DO_INFRA=true
            DO_PIPELINE=true
            DO_STT=true
            DO_BACKEND=true
            DO_ORCHESTRATOR=true
            ;;
        --infra)         DO_INFRA=true ;;
        --pipeline)      DO_PIPELINE=true ;;
        --stt)           DO_STT=true ;;
        --backend)       DO_BACKEND=true ;;
        --orchestrator)  DO_ORCHESTRATOR=true ;;
        --ayuda|--help)  mostrar_ayuda ;;
        *)
            echo -e "${RED}❌ Argumento desconocido: $arg${NC}"
            mostrar_ayuda
            ;;
    esac
done

# ─── Banner ────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   🤖  Robot Mesero Uchino — Arranque de Servicios     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""

# ─── 0. Cargar variables de entorno ───────────────────────────
echo -e "${YELLOW}[0/5] Cargando variables de entorno...${NC}"
if [ ! -f .env ]; then
    echo -e "${RED}   ❌ .env no encontrado en $SCRIPT_DIR${NC}"
    echo -e "${RED}   Copia desde .env.example o restaura desde backup${NC}"
    exit 1
fi
set -a; source .env; set +a
BACKEND_PORT="${PORT:-3005}"
echo -e "${GREEN}   ✅ Variables cargadas desde .env${NC}"

# ─── 1. Activar virtualenv (para --pipeline, --stt, --orchestrator) ──
VENV_DIR="$SCRIPT_DIR/WhisperLiveKit/venv"
activate_venv() {
    if [ -f "$VENV_DIR/bin/activate" ]; then
        # shellcheck disable=SC1091
        source "$VENV_DIR/bin/activate"
        echo -e "${GREEN}   ✅ Virtualenv activado: $VENV_DIR${NC}"
    else
        echo -e "${YELLOW}   ⚠️  Virtualenv no encontrado en $VENV_DIR${NC}"
        echo -e "${YELLOW}   Usando Python del sistema...${NC}"
    fi
}

# ─── 2. Infraestructura Docker ─────────────────────────────────
arrancar_infra() {
    echo -e "\n${YELLOW}[1/5] Levantando infraestructura Docker...${NC}"

    if ! command -v docker &>/dev/null; then
        echo -e "${RED}   ❌ Docker no instalado${NC}"
        return 1
    fi

    docker compose -f docker/docker-compose.infra.yml up -d
    echo -e "${GREEN}   ✅ Contenedores levantados${NC}"

    # Esperar healthchecks
    echo "   ⏳ Esperando PostgreSQL..."
    until docker exec chipi_postgres pg_isready -U chipi &>/dev/null 2>&1; do sleep 1; done
    echo -e "   ${GREEN}   ✅ PostgreSQL${NC}"

    echo "   ⏳ Esperando Redis..."
    until docker exec chipi_redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 1; done
    echo -e "   ${GREEN}   ✅ Redis${NC}"

    echo "   ⏳ Esperando ChromaDB..."
    until curl -sf http://localhost:8000/api/v1/heartbeat &>/dev/null; do sleep 1; done
    echo -e "   ${GREEN}   ✅ ChromaDB${NC}"

    echo "   ⏳ Esperando InfluxDB..."
    until curl -sf http://localhost:8086/health &>/dev/null; do sleep 1; done
    echo -e "   ${GREEN}   ✅ InfluxDB${NC}"

    echo "   ⏳ Verificando SQLite local..."
    mkdir -p data
    if [ ! -f data/robot_mesero.db ]; then
        touch data/robot_mesero.db
        echo "   📝 Base SQLite creada"
    fi
    echo -e "   ${GREEN}   ✅ SQLite: data/robot_mesero.db${NC}"
}

# ─── 3. Pipeline de audio ─────────────────────────────────────
arrancar_pipeline() {
    echo -e "\n${YELLOW}[2/5] Iniciando Audio Pipeline (Wake Word + DNF3 + SER) :8001...${NC}"

    if lsof -i :8001 &>/dev/null 2>&1; then
        echo -e "${YELLOW}   ⚠️  Puerto 8001 en uso — pipeline ya corriendo?${NC}"
        return 0
    fi

    activate_venv

    # Configuración de wake word
    export WAKE_WORD="${WAKE_WORD:-Oye Uchino}"
    export WAKE_WORD_THRESHOLD="${WAKE_WORD_THRESHOLD:-0.5}"
    export WAKE_WORD_PATIENCE="${WAKE_WORD_PATIENCE:-3}"
    export WAKE_WORD_ACTIVATION_TIMEOUT="${WAKE_WORD_ACTIVATION_TIMEOUT:-15.0}"

    echo "   Wake word: $WAKE_WORD"

    mkdir -p shared/logs
    nohup python -m audio_pipeline.pipeline_manager \
        > shared/logs/pipeline.log 2>&1 &
    PIPELINE_PID=$!
    echo $PIPELINE_PID > .pipeline.pid
    echo -e "${GREEN}   ✅ Pipeline PID $PIPELINE_PID (:8001)${NC}"
    sleep 2
}

# ─── 4. WhisperLiveKit STT ────────────────────────────────────
arrancar_stt() {
    echo -e "\n${YELLOW}[3/5] Iniciando WhisperLiveKit STT :8002...${NC}"

    if lsof -i :8002 &>/dev/null 2>&1; then
        echo -e "${YELLOW}   ⚠️  Puerto 8002 en uso — STT ya corriendo?${NC}"
        return 0
    fi

    activate_venv

    mkdir -p shared/logs
    nohup wlk --backend faster-whisper --model large-v3-turbo --language es --pcm-input --diarization --port 8002 \
        > shared/logs/stt.log 2>&1 &
    STT_PID=$!
    echo $STT_PID > .stt.pid
    echo -e "${GREEN}   ✅ WhisperLiveKit PID $STT_PID (:8002)${NC}"
    sleep 3
}

# ─── 5. Orchestrator sidecar ──────────────────────────────────
arrancar_orchestrator() {
    echo -e "\n${YELLOW}[4/5] Iniciando Orchestrator Sidecar (Python) :8100...${NC}"

    if lsof -i :8100 &>/dev/null 2>&1; then
        echo -e "${YELLOW}   ⚠️  Puerto 8100 en uso — orchestrator ya corriendo?${NC}"
        return 0
    fi

    activate_venv

    # Verificar dependencias
    python3 -c "import fastapi, uvicorn" 2>/dev/null || {
        echo -e "${RED}   ❌ fastapi/uvicorn no instalados${NC}"
        echo -e "${YELLOW}   Instala: pip install fastapi uvicorn${NC}"
        return 1
    }

    mkdir -p shared/logs
    nohup python3 -m uvicorn orchestrator.server:app \
        --host 127.0.0.1 --port 8100 \
        --log-level info \
        > shared/logs/orchestrator.log 2>&1 &
    ORCH_PID=$!
    echo $ORCH_PID > .orchestrator.pid
    echo -e "${GREEN}   ✅ Orchestrator PID $ORCH_PID (:8100)${NC}"
    sleep 2

    # Health check
    curl -sf http://127.0.0.1:8100/health &>/dev/null && \
        echo -e "${GREEN}   ✅ Orchestrator health OK${NC}" || \
        echo -e "${YELLOW}   ⚠️  Orchestrator health check falló${NC}"
}

# ─── 6. Backend API ───────────────────────────────────────────
arrancar_backend() {
    echo -e "\n${YELLOW}[5/5] Iniciando Backend API (Node.js) :${BACKEND_PORT}...${NC}"

    if curl -sf "http://127.0.0.1:${BACKEND_PORT}/api/status" &>/dev/null; then
        echo -e "${GREEN}   ✅ Backend saludable en :${BACKEND_PORT}; se reutiliza${NC}"
        return 0
    fi

    if lsof -i :"${BACKEND_PORT}" &>/dev/null 2>&1; then
        echo -e "${YELLOW}   ⚠️  Puerto ${BACKEND_PORT} ocupado por un proceso no saludable; no se crea un duplicado${NC}"
        return 1
    fi

    if ! command -v node &>/dev/null; then
        echo -e "${RED}   ❌ Node.js no instalado${NC}"
        return 1
    fi

    node -v | grep -E "v2[0-9]" &>/dev/null || {
        echo -e "${RED}   ❌ Node.js >= 20 requerido${NC}"
        return 1
    }

    # Instalar dependencias si faltan
    echo "   Verificando dependencias..."
    cd backend_api
    if [ ! -d node_modules ]; then
        npm install --silent 2>/dev/null || true
    fi
    cd "$SCRIPT_DIR"

    mkdir -p shared/logs
    nohup node backend_api/src/server.mjs \
        > shared/logs/backend_v3.log 2>&1 &
    BACKEND_PID=$!
    echo $BACKEND_PID > .backend.pid
    echo -e "${GREEN}   ✅ Backend API PID $BACKEND_PID (:${BACKEND_PORT})${NC}"
    sleep 2

    # Verificar que arrancó
    if kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo -e "${GREEN}   ✅ Backend proceso vivo${NC}"
    else
        echo -e "${RED}   ❌ Backend falló al iniciar (revisa shared/logs/backend_v3.log)${NC}"
    fi
}

# ═══════════════════════════════════════════════════════════════
# EJECUCIÓN
# ═══════════════════════════════════════════════════════════════
STEP=0
TOTAL=0
$DO_INFRA && TOTAL=$((TOTAL + 1))
$DO_PIPELINE && TOTAL=$((TOTAL + 1))
$DO_STT && TOTAL=$((TOTAL + 1))
$DO_ORCHESTRATOR && TOTAL=$((TOTAL + 1))
$DO_BACKEND && TOTAL=$((TOTAL + 1))

echo -e "${BLUE}══════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Modo:${NC} $([ "$TOTAL" -eq 0 ] && echo "ninguno" || echo "$TOTAL servicio(s) a iniciar")"
echo -e "${BLUE}══════════════════════════════════════════════════════${NC}"

# ── Ejecutar en orden lógico ──────────────────────────────────
$DO_INFRA && { STEP=$((STEP + 1)); echo -e "\n${CYAN}[$STEP/$TOTAL] Infraestructura Docker${NC}"; arrancar_infra; }
$DO_PIPELINE && { STEP=$((STEP + 1)); echo -e "\n${CYAN}[$STEP/$TOTAL] Audio Pipeline${NC}"; arrancar_pipeline; }
$DO_STT && { STEP=$((STEP + 1)); echo -e "\n${CYAN}[$STEP/$TOTAL] Whisper STT${NC}"; arrancar_stt; }
$DO_ORCHESTRATOR && { STEP=$((STEP + 1)); echo -e "\n${CYAN}[$STEP/$TOTAL] Orchestrator${NC}"; arrancar_orchestrator; }
$DO_BACKEND && { STEP=$((STEP + 1)); echo -e "\n${CYAN}[$STEP/$TOTAL] Backend API${NC}"; arrancar_backend || { echo -e "${RED}❌ Backend no saludable; arranque abortado${NC}"; exit 1; }; }

# ── Resumen ────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅ Arranque completado${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "Endpoints:"
echo -e "  ${CYAN}API:${NC}        http://localhost:${BACKEND_PORT}"
echo -e "  ${CYAN}Robot UI:${NC}   http://localhost:${BACKEND_PORT}/robot"
echo -e "  ${CYAN}Grafana:${NC}    http://localhost:3000"
echo -e "  ${CYAN}ChromaDB:${NC}   http://localhost:8000"
echo -e "  ${CYAN}InfluxDB:${NC}   http://localhost:8086"
echo ""
echo -e "Para ver logs: bash scripts/ver_logs.sh --ayuda"
echo -e "Para ver estado: bash scripts/estado.sh"
echo -e "Para detener: bash stop_robot.sh"
echo ""
