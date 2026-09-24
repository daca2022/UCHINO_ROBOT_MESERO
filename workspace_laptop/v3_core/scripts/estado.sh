#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# estado.sh — Health check rápido del Robot Mesero Uchino
# ═══════════════════════════════════════════════════════════════
# Uso:
#   bash scripts/estado.sh        # Verifica todos los servicios
#   bash scripts/estado.sh --json # Salida en JSON (para tooling)
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ─── Colores ANSI ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Directorio base ───────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$SCRIPT_DIR"

# ─── Parsear argumentos ────────────────────────────────────────
OUTPUT_JSON=false
for arg in "$@"; do
    case "$arg" in
        --json) OUTPUT_JSON=true ;;
        --ayuda|--help)
            echo -e "${CYAN}Uso:${NC} bash scripts/estado.sh [--json]"
            echo "  --json   Salida en formato JSON"
            exit 0
            ;;
    esac
done

# ─── Variables para conteo ─────────────────────────────────────
TOTAL=0
OK=0
FAIL=0
JSON_RESULTS=""

# ─── Función de chequeo ───────────────────────────────────────
check_service() {
    local name="$1"       # Nombre visible
    local key="$2"        # Clave para JSON
    local desc="$3"       # Descripción breve
    local result="$4"     # "ok" o "fail"
    local detail="$5"     # Detalle adicional

    TOTAL=$((TOTAL + 1))
    [ -n "$JSON_RESULTS" ] && JSON_RESULTS+=","
    JSON_RESULTS+="{\"name\":\"$name\",\"key\":\"$key\",\"status\":\"$result\",\"detail\":\"$detail\"}"

    if [ "$OUTPUT_JSON" = false ]; then
        if [ "$result" = "ok" ]; then
            echo -e "  ${GREEN}✅${NC} $name — $desc"
            OK=$((OK + 1))
        else
            echo -e "  ${RED}❌${NC} $name — $detail"
            FAIL=$((FAIL + 1))
        fi
    else
        if [ "$result" = "ok" ]; then
            OK=$((OK + 1))
        else
            FAIL=$((FAIL + 1))
        fi
    fi
}

# ─── Banner ────────────────────────────────────────────────────
if [ "$OUTPUT_JSON" = false ]; then
    echo ""
    echo -e "${CYAN}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║   🔍  Robot Mesero Uchino — Health Check              ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${YELLOW}Verificando servicios...${NC}"
    echo ""
fi

# ─── 1. Docker containers ─────────────────────────────────────
DOCKER_OK=false
DOCKER_DETALLE=""
if command -v docker &>/dev/null; then
    CHIPI_CONTAINERS=$(docker ps --filter "name=chipi_" --format "{{.Names}}" 2>/dev/null || true)
    if [ -n "$CHIPI_CONTAINERS" ]; then
        DOCKER_OK=true
        DOCKER_DETALLE=$(echo "$CHIPI_CONTAINERS" | tr '\n' ' ')
    else
        DOCKER_DETALLE="No hay contenedores chipi_* corriendo"
    fi
else
    DOCKER_DETALLE="Docker no instalado"
fi

if [ "$DOCKER_OK" = true ]; then
    check_service "Docker Infra" "docker" "Contenedores: $DOCKER_DETALLE" "ok" ""
else
    check_service "Docker Infra" "docker" "" "fail" "$DOCKER_DETALLE"
fi

# ─── 2. Backend API (:3005) ───────────────────────────────────
BACKEND_STATUS="fail"
BACKEND_DETALLE="No responde"
if command -v curl &>/dev/null; then
    BACKEND_RESP=$(curl -sf --max-time 5 http://localhost:3005/api/status 2>/dev/null || true)
    if [ -n "$BACKEND_RESP" ]; then
        BACKEND_STATUS="ok"
        BACKEND_DETALLE="Responde en :3005"
    else
        BACKEND_DETALLE="curl http://localhost:3005/api/status falló"
    fi
fi

if [ "$BACKEND_STATUS" = "ok" ]; then
    check_service "Backend API" "backend" "$BACKEND_DETALLE" "ok" ""
else
    check_service "Backend API" "backend" "" "fail" "$BACKEND_DETALLE"
fi

# ─── 3. Pipeline (:8001) ──────────────────────────────────────
PIPELINE_STATUS="fail"
PIPELINE_DETALLE="No responde"
if command -v lsof &>/dev/null && lsof -i :8001 &>/dev/null 2>&1; then
    PIPELINE_STATUS="ok"
    PIPELINE_DETALLE="Puerto :8001 abierto"
elif curl -sf --max-time 3 http://localhost:8001/health &>/dev/null 2>&1; then
    PIPELINE_STATUS="ok"
    PIPELINE_DETALLE="Health check OK en :8001"
else
    PIPELINE_DETALLE="Puerto :8001 no disponible"
fi

if [ "$PIPELINE_STATUS" = "ok" ]; then
    check_service "Pipeline Audio" "pipeline" "$PIPELINE_DETALLE" "ok" ""
else
    check_service "Pipeline Audio" "pipeline" "" "fail" "$PIPELINE_DETALLE"
fi

# ─── 4. STT WhisperLiveKit (:8002) ────────────────────────────
STT_STATUS="fail"
STT_DETALLE="No responde"
if command -v lsof &>/dev/null && lsof -i :8002 &>/dev/null 2>&1; then
    STT_STATUS="ok"
    STT_DETALLE="Puerto :8002 abierto"
elif curl -sf --max-time 3 http://localhost:8002/health &>/dev/null 2>&1; then
    STT_STATUS="ok"
    STT_DETALLE="Health check OK en :8002"
else
    STT_DETALLE="Puerto :8002 no disponible"
fi

if [ "$STT_STATUS" = "ok" ]; then
    check_service "WhisperLiveKit STT" "stt" "$STT_DETALLE" "ok" ""
else
    check_service "WhisperLiveKit STT" "stt" "" "fail" "$STT_DETALLE"
fi

# ─── 5. Orchestrator sidecar (:8100) ──────────────────────────
ORCH_STATUS="fail"
ORCH_DETALLE="No responde"
if command -v curl &>/dev/null; then
    ORCH_RESP=$(curl -sf --max-time 5 http://127.0.0.1:8100/health 2>/dev/null || true)
    if [ -n "$ORCH_RESP" ]; then
        ORCH_STATUS="ok"
        ORCH_DETALLE="Health check OK en :8100"
    else
        ORCH_DETALLE="curl http://127.0.0.1:8100/health falló"
    fi
fi

if [ "$ORCH_STATUS" = "ok" ]; then
    check_service "Orchestrator Sidecar" "orchestrator" "$ORCH_DETALLE" "ok" ""
else
    check_service "Orchestrator Sidecar" "orchestrator" "" "fail" "$ORCH_DETALLE"
fi

# ─── 6. Archivos PID ──────────────────────────────────────────
PID_FILES=""
for pidfile in .backend.pid .orchestrator.pid .pipeline.pid .stt.pid; do
    if [ -f "$pidfile" ]; then
        PID_PID=$(cat "$pidfile" 2>/dev/null || echo "?")
        PID_FILES+="$pidfile($PID_PID) "
    fi
done

if [ -n "$PID_FILES" ]; then
    check_service "Archivos PID" "pid_files" "$PID_FILES" "ok" ""
else
    check_service "Archivos PID" "pid_files" "Sin archivos .pid" "ok" "Sin procesos gestionados vía .pid"
fi

# ─── Cerrar JSON ──────────────────────────────────────────────
JSON_RESULTS="[$JSON_RESULTS]"

# ─── Resumen ───────────────────────────────────────────────────
if [ "$OUTPUT_JSON" = true ]; then
    echo "{\"total\":$TOTAL,\"ok\":$OK,\"fail\":$FAIL,\"services\":$JSON_RESULTS}"
else
    echo ""
    echo "═══════════════════════════════════════════════════════"
    if [ "$FAIL" -eq 0 ]; then
        echo -e "${GREEN}  ✅ Todos los servicios operativos ($OK/$TOTAL)${NC}"
    elif [ "$OK" -gt 0 ]; then
        echo -e "${YELLOW}  ⚠️  $OK/$TOTAL servicios OK, $FAIL fallaron${NC}"
        echo ""
        echo -e "${YELLOW}  Sugerencias:${NC}"
        [ "$DOCKER_OK" != true ] && echo "  • Levanta Docker: bash scripts/iniciar_chipi.sh --infra"
        [ "$PIPELINE_STATUS" != "ok" ] && echo "  • Levanta pipeline: bash scripts/iniciar_chipi.sh --pipeline"
        [ "$STT_STATUS" != "ok" ] && echo "  • Levanta STT: bash scripts/iniciar_chipi.sh --stt"
        [ "$BACKEND_STATUS" != "ok" ] && echo "  • Levanta backend: bash scripts/iniciar_chipi.sh --backend"
        [ "$ORCH_STATUS" != "ok" ] && echo "  • Levanta orchestrator: bash scripts/iniciar_chipi.sh --orchestrator"
        echo ""
        echo -e "  ${CYAN}Logs:${NC} bash scripts/ver_logs.sh --ayuda"
    else
        echo -e "${RED}  ❌ Todos los servicios caídos ($FAIL/$TOTAL)${NC}"
        echo ""
        echo -e "  ${CYAN}Arranque completo:${NC} bash scripts/iniciar_chipi.sh --full"
    fi
    echo "═══════════════════════════════════════════════════════"
    echo ""
fi
