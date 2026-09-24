#!/usr/bin/env bash
# start_pln.sh — Start the Chipi PLN voice pipeline service
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f .env ]; then
    set -a
    source .env
    set +a
fi

export PYTHONPATH="$SCRIPT_DIR${PYTHONPATH:+:$PYTHONPATH}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[PLN]${NC} $1"; }
warn() { echo -e "${YELLOW}[PLN]${NC} $1"; }
error() { echo -e "${RED}[PLN]${NC} $1"; }

check_service() {
    local name=$1
    local url=$2
    if curl -sf "$url" > /dev/null 2>&1; then
        log "$name is running ✓"
        return 0
    else
        warn "$name is NOT running at $url"
        return 1
    fi
}

log "Checking dependencies..."
BACKEND_OK=true
check_service "Backend API" "http://localhost:${PORT:-3005}/api/status" || BACKEND_OK=false

# Audio pipeline and STT are optional in standalone mode
check_service "Audio Pipeline" "http://localhost:${PIPELINE_PORT:-8001}/health" 2>/dev/null || true
check_service "WhisperLiveKit" "http://localhost:${WLK_PORT:-8002}/health" 2>/dev/null || true

if [ "$BACKEND_OK" = false ]; then
    error "Backend API is not running! Start it first: cd backend_api && node src/server.mjs"
    exit 1
fi

mkdir -p shared/logs

log "Starting Chipi PLN service..."
log "Press Ctrl+C to stop"

cleanup() {
    log "Shutting down PLN service..."
    kill $PLN_PID 2>/dev/null
    wait $PLN_PID 2>/dev/null
    log "PLN service stopped"
    exit 0
}
trap cleanup SIGINT SIGTERM

python3 -m pln.main 2>&1 | tee -a shared/logs/pln.log &
PLN_PID=$!

log "PLN service started (PID: $PLN_PID)"
log "Logs: shared/logs/pln.log"

wait $PLN_PID
