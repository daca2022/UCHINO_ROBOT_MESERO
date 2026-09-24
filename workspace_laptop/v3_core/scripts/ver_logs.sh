#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# ver_logs.sh — Visualización unificada de logs de Chipi
# ═══════════════════════════════════════════════════════════════
# Uso:
#   bash scripts/ver_logs.sh --backend        # Log del backend API
#   bash scripts/ver_logs.sh --pipeline       # Log del audio pipeline
#   bash scripts/ver_logs.sh --stt            # Log de WhisperLiveKit STT
#   bash scripts/ver_logs.sh --orchestrator   # Log del orchestrator sidecar
#   bash scripts/ver_logs.sh --conversacion   # Conversación filtrada en vivo
#   bash scripts/ver_logs.sh --ayuda          # Esta ayuda
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ─── Colores ANSI ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ─── Directorio base ───────────────────────────────────────────
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
LOG_DIR="$SCRIPT_DIR/shared/logs"

mostrar_ayuda() {
    echo -e "${CYAN}Uso:${NC} bash scripts/ver_logs.sh [OPCIONES]"
    echo ""
    echo "Opciones:"
    echo "  --backend        tail -f del backend API (shared/logs/backend_v3.log)"
    echo "  --pipeline       tail -f del audio pipeline (shared/logs/pipeline.log)"
    echo "  --stt            tail -f de WhisperLiveKit (shared/logs/stt.log)"
    echo "  --orchestrator   tail -f del orchestrator sidecar (shared/logs/orchestrator.log)"
    echo "  --conversacion   Filtra en vivo la conversación desde el backend"
    echo "  --ayuda          Mostrar esta ayuda"
    echo ""
    echo "Ejemplos:"
    echo "  bash scripts/ver_logs.sh --backend"
    echo "  bash scripts/ver_logs.sh --conversacion"
    exit 0
}

# ─── Parsear argumentos ────────────────────────────────────────
if [ $# -eq 0 ]; then
    mostrar_ayuda
fi

VER_BACKEND=false
VER_PIPELINE=false
VER_STT=false
VER_ORCHESTRATOR=false
VER_CONVERSACION=false

for arg in "$@"; do
    case "$arg" in
        --backend)       VER_BACKEND=true ;;
        --pipeline)      VER_PIPELINE=true ;;
        --stt)           VER_STT=true ;;
        --orchestrator)  VER_ORCHESTRATOR=true ;;
        --conversacion)  VER_CONVERSACION=true ;;
        --ayuda|--help)  mostrar_ayuda ;;
        *)
            echo -e "${RED}❌ Argumento desconocido: $arg${NC}"
            mostrar_ayuda
            ;;
    esac
done

# ─── Verificación de archivos de log ──────────────────────────
mkdir -p "$LOG_DIR"

# ─── Backend API ───────────────────────────────────────────────
ver_backend() {
    local logfile="$LOG_DIR/backend_v3.log"
    echo -e "${GREEN}📡 Backend API — siguiendo $logfile${NC}"
    echo -e "${YELLOW}   Ctrl+C para salir${NC}"
    echo "═══════════════════════════════════════════════════════"
    if [ -f "$logfile" ]; then
        tail -f "$logfile"
    else
        echo -e "${YELLOW}⚠️  Archivo $logfile no existe. Esperando a que se cree...${NC}"
        touch "$logfile"
        tail -f "$logfile"
    fi
}

# ─── Pipeline de audio ─────────────────────────────────────────
ver_pipeline() {
    local logfile="$LOG_DIR/pipeline.log"
    echo -e "${GREEN}🎤 Audio Pipeline — siguiendo $logfile${NC}"
    echo -e "${YELLOW}   Ctrl+C para salir${NC}"
    echo "═══════════════════════════════════════════════════════"
    if [ -f "$logfile" ]; then
        tail -f "$logfile"
    else
        echo -e "${YELLOW}⚠️  Archivo $logfile no existe. Esperando...${NC}"
        touch "$logfile"
        tail -f "$logfile"
    fi
}

# ─── WhisperLiveKit STT ───────────────────────────────────────
ver_stt() {
    local logfile="$LOG_DIR/stt.log"
    echo -e "${GREEN}🗣️  WhisperLiveKit STT — siguiendo $logfile${NC}"
    echo -e "${YELLOW}   Ctrl+C para salir${NC}"
    echo "═══════════════════════════════════════════════════════"
    if [ -f "$logfile" ]; then
        tail -f "$logfile"
    else
        echo -e "${YELLOW}⚠️  Archivo $logfile no existe. Esperando...${NC}"
        touch "$logfile"
        tail -f "$logfile"
    fi
}

# ─── Orchestrator sidecar ─────────────────────────────────────
ver_orchestrator() {
    local logfile="$LOG_DIR/orchestrator.log"
    echo -e "${GREEN}⚙️  Orchestrator Sidecar — siguiendo $logfile${NC}"
    echo -e "${YELLOW}   Ctrl+C para salir${NC}"
    echo "═══════════════════════════════════════════════════════"
    if [ -f "$logfile" ]; then
        tail -f "$logfile"
    else
        echo -e "${YELLOW}⚠️  Archivo $logfile no existe. Esperando...${NC}"
        touch "$logfile"
        tail -f "$logfile"
    fi
}

# ─── Conversación filtrada ─────────────────────────────────────
ver_conversacion() {
    local logfile="$LOG_DIR/backend_v3.log"
    echo -e "${GREEN}💬 Conversación con Chipi — filtrando $logfile${NC}"
    echo -e "${YELLOW}   Ctrl+C para salir${NC}"
    echo "═══════════════════════════════════════════════════════"

    if [ ! -f "$logfile" ]; then
        echo -e "${YELLOW}⚠️  Archivo $logfile no existe. Esperando...${NC}"
        touch "$logfile"
    fi

    tail -f "$logfile" 2>/dev/null | while IFS= read -r line; do
        case "$line" in
            *"ASR result:"*)
                TEXT=$(echo "$line" | sed 's/.*ASR result: //' | sed 's/ (+.*//')
                echo ""
                echo -e "🗣️  ${BLUE}TÚ:${NC} $TEXT"
                echo "─────────────────────────────────────────"
                ;;
            *"LLM result:"*|*"LLM response:"*)
                TEXT=$(echo "$line" | sed 's/.*result: //' | sed 's/.*response: //' | sed 's/ (+.*//')
                echo -e "🤖 ${CYAN}CHIPI:${NC} $TEXT"
                ;;
            *"TTS done"*)
                echo -e "🔊   ${GREEN}(audio enviado al altavoz)${NC}"
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                ;;
            *"Robot conectado"*|*"WS Robot conectado"*)
                echo -e "🔌 ${GREEN}ESP32 conectado${NC}"
                ;;
            *"Robot desconectado"*|*"WS Robot desconectado"*)
                echo -e "⚠️  ${YELLOW}ESP32 desconectado${NC}"
                ;;
            *"Error crítico"*|*"ERROR"*|*"FATAL"*)
                echo -e "💥 ${RED}$line${NC}"
                ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════
# EJECUCIÓN
# ═══════════════════════════════════════════════════════════════
if [ "$VER_CONVERSACION" = true ]; then
    ver_conversacion
elif [ "$VER_BACKEND" = true ]; then
    ver_backend
elif [ "$VER_PIPELINE" = true ]; then
    ver_pipeline
elif [ "$VER_STT" = true ]; then
    ver_stt
elif [ "$VER_ORCHESTRATOR" = true ]; then
    ver_orchestrator
else
    echo -e "${YELLOW}⚠️  No se seleccionó ningún servicio.${NC}"
    mostrar_ayuda
fi
