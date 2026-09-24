#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# download_qwen3.sh — Download Qwen3-14B Q4_K_M via Ollama
# ─────────────────────────────────────────────────────────────
# Runs on RTX 5000 (16 GB VRAM). Qwen3-14B Q4_K_M ≈ 9 GB when loaded.
# This script:
#   1. Installs Ollama if not present
#   2. Pulls the Qwen3-14B Q4_K_M model
#   3. Tests a quick inference
#   4. Keeps model cached for QwenAdapter.mjs
# ─────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ── Detect GPU ──────────────────────────────────────────
if command -v nvidia-smi &>/dev/null; then
    GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo "0")
    log_info "GPU VRAM: ${GPU_MEM} MB"
    if [ "$GPU_MEM" -lt 14000 ] 2>/dev/null; then
        log_warn "⚠  Less than 14 GB VRAM detected. Qwen3-14B Q4_K_M needs ~9 GB."
        log_warn "   Consider using a smaller model like qwen3:8b instead."
    fi
else
    log_warn "No NVIDIA GPU detected. Qwen3 will run on CPU (slow)."
fi

# ── 1. Install Ollama ────────────────────────────────────
install_ollama() {
    if command -v ollama &>/dev/null; then
        log_info "Ollama ya está instalado: $(ollama --version 2>/dev/null || echo 'version desconocida')"
        return 0
    fi

    log_info "Instalando Ollama..."
    if ! curl -fsSL https://ollama.com/install.sh | sh; then
        log_error "Error instalando Ollama. Instala manualmente: curl -fsSL https://ollama.com/install.sh | sh"
        exit 1
    fi

    # Wait for ollama service to start
    log_info "Esperando que el servicio Ollama se inicie..."
    for i in $(seq 1 15); do
        if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
            log_info "Ollama service ready."
            break
        fi
        sleep 1
    done
}

# ── 2. Pull model ────────────────────────────────────────
pull_model() {
    local MODEL="qwen3:14b"
    log_info "Descargando ${MODEL} (Q4_K_M, ~9 GB)..."
    log_info "Esto puede tomar varios minutos según tu conexión."

    if ollama pull "$MODEL"; then
        log_info "✓ Modelo ${MODEL} descargado correctamente."
    else
        log_error "Error descargando ${MODEL}. Revisa conexión y espacio en disco."
        log_error "Requisito mínimo: ~12 GB libres en disco."
        exit 1
    fi
}

# ── 3. Test inference ────────────────────────────────────
test_inference() {
    local MODEL="qwen3:14b"
    log_info "Probando inferencia rápida..."

    local RESPONSE
    RESPONSE=$(curl -s http://localhost:11434/api/generate \
        -d "{
            \"model\": \"${MODEL}\",
            \"prompt\": \"Responde solo 'OK' en una palabra.\",
            \"stream\": false,
            \"options\": {
                \"num_predict\": 10,
                \"temperature\": 0.1
            }
        }")

    local TEXT
    TEXT=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('response','ERROR'))" 2>/dev/null || echo "PARSE_ERROR")

    if echo "$TEXT" | grep -qi "ok"; then
        log_info "✓ Inferencia exitosa: ${TEXT}"
    elif [ "$TEXT" = "PARSE_ERROR" ]; then
        log_warn "Inferencia completada pero no se pudo parsear respuesta."
        log_warn "Respuesta cruda: $(echo "$RESPONSE" | head -c 200)"
    else
        log_info "Inferencia completada: ${TEXT}"
    fi
}

# ── 4. Show model info ───────────────────────────────────
show_info() {
    local MODEL="qwen3:14b"
    log_info "Modelo descargado. Información:"
    ollama show "$MODEL" 2>/dev/null || true
    echo ""
    log_info "Para usar desde Node.js:"
    echo "  const QwenAdapter = require('./adapters/QwenAdapter.mjs');"
    echo "  const qwen = new QwenAdapter({ model: '${MODEL}' });"
    echo ""
    log_info "VRAM en reposo: ~0 GB (modelo descargado pero no cargado)"
    log_info "VRAM activo:    ~9 GB"
    log_info "Para precargar: ollama run ${MODEL}"
}

# ── Main ──────────────────────────────────────────────────
main() {
    echo ""
    echo "═══════════════════════════════════════════════════"
    echo "  Qwen3-14B — Offline Fallback Setup"
    echo "═══════════════════════════════════════════════════"
    echo ""

    install_ollama
    pull_model
    test_inference
    show_info

    echo ""
    log_info "✓ Setup completo. Qwen3-14B listo como fallback offline."
    echo ""
}

main "$@"
