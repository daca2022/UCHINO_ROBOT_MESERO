#!/bin/bash
echo "Iniciando WhisperLiveKit (STT Engine) en puerto 8002..."

source /home/david/chipi_workspace_pln/v3_core/WhisperLiveKit/venv/bin/activate

wlk --backend faster-whisper --model large-v3-turbo --language es --pcm-input --port 8002
