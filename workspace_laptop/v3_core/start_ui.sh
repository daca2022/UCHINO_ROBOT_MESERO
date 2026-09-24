#!/bin/bash
set -e

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR/frontend_ui"

echo -e "\033[0;32m🖥️  Chipi Frontend UI\033[0m"
echo "═══════════════════════════════════════════════════════"

echo -e "\033[1;33m[CHECK] Verificando dependencias...\033[0m"

BACKEND_OK=false
ORCH_OK=false

curl -sf http://localhost:3005/api/status >/dev/null 2>&1 && {
  BACKEND_OK=true
  echo -e "   \033[0;32m✅ Backend Node.js (:3005) OK\033[0m"
} || {
  echo -e "   \033[0;31m❌ Backend Node.js (:3005) NO disponible\033[0m"
  echo -e "   \033[1;33m   ℹ️  Ejecuta primero: cd v3_core && bash start_robot.sh\033[0m"
}

curl -sf http://localhost:8100/health >/dev/null 2>&1 && {
  ORCH_OK=true
  echo -e "   \033[0;32m✅ Orchestrator Python (:8100) OK\033[0m"
} || {
  echo -e "   \033[0;33m⚠️  Orchestrator Python (:8100) NO disponible (opcional)\033[0m"
}

echo ""

MODE="${1:-dev}"

if [ "$MODE" = "build" ]; then
  echo -e "\033[1;33m[1/2] Compilando para producción...\033[0m"
  npm run build
  echo -e "\033[0;32m✅ Build listo en dist/\033[0m"
  echo -e "\033[1;33m[2/2] Iniciando preview con --host...\033[0m"
  echo -e "   URL local:   http://localhost:5173"
  echo -e "   URL red:     http://$(hostname -I | awk '{print $1}'):5173"
  echo "═══════════════════════════════════════════════════════"
  npx vite preview --host --port 5173
else
  echo -e "\033[1;33m[1/1] Iniciando Vite dev server con --host...\033[0m"
  echo -e "   URL local:   http://localhost:5173"
  echo -e "   URL red:     http://$(hostname -I | awk '{print $1}'):5173"
  echo "═══════════════════════════════════════════════════════"
  npx vite --host --port 5173
fi
