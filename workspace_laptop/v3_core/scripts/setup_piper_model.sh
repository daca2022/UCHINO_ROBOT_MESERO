#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_DIR="$ROOT_DIR/models/piper"
mkdir -p "$MODEL_DIR"

MODEL_NAME="es_ES-davefx-medium"
BASE_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium"

echo "[Piper] Descargando modelo $MODEL_NAME..."
curl -fL "$BASE_URL/${MODEL_NAME}.onnx" -o "$MODEL_DIR/${MODEL_NAME}.onnx"
curl -fL "$BASE_URL/${MODEL_NAME}.onnx.json" -o "$MODEL_DIR/${MODEL_NAME}.onnx.json"

echo "[Piper] ✅ Modelo descargado en: $MODEL_DIR"
echo "[Piper] Actualiza tu .env con:"
echo "  TTS_ENGINE=piper"
echo "  PIPER_MODEL=./models/piper/${MODEL_NAME}.onnx"
echo "  PIPER_CONFIG=./models/piper/${MODEL_NAME}.onnx.json"
