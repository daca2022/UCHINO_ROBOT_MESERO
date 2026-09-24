#!/bin/bash
echo "Iniciando Audio Pipeline (Wake Word + DeepFilterNet3 + SER proxy) en puerto 8001..."
cd /home/david/chipi_workspace_pln/v3_core
source WhisperLiveKit/venv/bin/activate

# Wake Word Configuration (configurable via env)
export WAKE_WORD="${WAKE_WORD:-Oye Uchino}"
export WAKE_WORD_THRESHOLD="${WAKE_WORD_THRESHOLD:-0.5}"
export WAKE_WORD_PATIENCE="${WAKE_WORD_PATIENCE:-3}"
export WAKE_WORD_ACTIVATION_TIMEOUT="${WAKE_WORD_ACTIVATION_TIMEOUT:-15.0}"
# Point to custom ONNX model when available:
# export WAKE_WORD_MODEL_PATH="wake_word/models/oye_chipi_v0.1.onnx"

echo "  Wake word: $WAKE_WORD (threshold=$WAKE_WORD_THRESHOLD, patience=$WAKE_WORD_PATIENCE)"

python -m audio_pipeline.pipeline_manager
