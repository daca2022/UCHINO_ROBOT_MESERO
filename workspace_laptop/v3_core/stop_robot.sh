#!/bin/bash
# ═══════════════════════════════════════════════════════════
# stop_robot.sh — Detiene servicios del Robot Mesero
# ═══════════════════════════════════════════════════════════
set -e

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"

echo "🛑 Deteniendo Robot Mesero Uchino..."
echo "═══════════════════════════════════════════════════════"

# 1. Orchestrator sidecar (Python)
if [ -f .orchestrator.pid ]; then
    ORCH_PID=$(cat .orchestrator.pid)
    if kill -0 $ORCH_PID 2>/dev/null; then
        kill $ORCH_PID 2>/dev/null && echo "   ✅ Orchestrator sidecar detenido"
    fi
    rm -f .orchestrator.pid
fi

# 2. Backend API (Node.js)
if [ -f .backend.pid ]; then
    BACKEND_PID=$(cat .backend.pid)
    if kill -0 $BACKEND_PID 2>/dev/null; then
        kill $BACKEND_PID 2>/dev/null && echo "   ✅ Backend API detenido"
    fi
    rm -f .backend.pid
fi

# 3. Docker infra (opcional)
if docker ps -q --filter "name=chipi_" | grep -q .; then
    echo "   ⏳ Deteniendo contenedores Docker..."
    docker compose -f docker/docker-compose.infra.yml down 2>/dev/null && \
        echo "   ✅ Docker infra detenido"
fi

echo ""
echo "✅ Robot Mesero detenido"
