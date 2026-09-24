#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"
echo "Iniciando WhisperLiveKit (STT Engine) en puerto 8002..."

if [ ! -f WhisperLiveKit/venv/bin/activate ]; then
  echo "Falta WhisperLiveKit/venv. Este servicio es opcional y no viene incluido en la publicación pública."
  exit 2
fi
source WhisperLiveKit/venv/bin/activate

wlk --backend faster-whisper --model large-v3-turbo --language es --pcm-input --port 8002
