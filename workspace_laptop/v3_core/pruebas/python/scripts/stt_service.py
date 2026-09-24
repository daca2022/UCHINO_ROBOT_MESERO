#!/usr/bin/env python3
"""
🎧 Servicio STT — faster-whisper HTTP API
Puerto 8001 | Recibe audio PCM 16kHz 16-bit → devuelve texto transcrito

Compatible con el flujo Node-RED: POST /transcribe
Body: raw PCM 16-bit signed LE, 16kHz
Response: {"text": "transcripción aquí"}

Instalación:
  pip3 install faster-whisper flask

Uso:
  python3 stt_service.py
"""

import io
import wave
import struct
import logging
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [STT] %(message)s")
log = logging.getLogger("stt")

SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit
MODEL_SIZE = "small"   # small = buena relación calidad/velocidad en CPU
DEVICE = "cpu"         # "cuda" si hay GPU libre
COMPUTE_TYPE = "int8"  # int8 para CPU, float16 para GPU
PORT = 8001

app = Flask(__name__)
model = None


def pcm_to_wav(pcm_bytes: bytes) -> bytes:
    """Convierte PCM 16-bit 16kHz raw a WAV en memoria."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """Recibe PCM raw 16kHz 16-bit y devuelve transcripción."""
    pcm_data = request.get_data()
    if not pcm_data or len(pcm_data) < 1600:  # mínimo ~50ms
        return jsonify({"text": "", "error": "audio muy corto"}), 400

    duration_s = len(pcm_data) / (SAMPLE_RATE * SAMPLE_WIDTH)
    log.info(f"Recibido: {len(pcm_data)} bytes ({duration_s:.1f}s)")

    wav_data = pcm_to_wav(pcm_data)
    wav_io = io.BytesIO(wav_data)

    segments, info = model.transcribe(
        wav_io,
        language="es",
        beam_size=3,
        vad_filter=True,
        vad_parameters=dict(
            min_silence_duration_ms=500,
            speech_pad_ms=200
        )
    )

    text = " ".join(seg.text.strip() for seg in segments).strip()
    log.info(f"Transcripción: '{text}' (idioma={info.language}, prob={info.language_probability:.2f})")

    return jsonify({
        "text": text,
        "language": info.language,
        "duration": round(duration_s, 2)
    })


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "model": MODEL_SIZE, "device": DEVICE})


if __name__ == "__main__":
    log.info(f"Cargando modelo faster-whisper '{MODEL_SIZE}' en {DEVICE}...")
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    log.info(f"Modelo cargado. Iniciando servidor en puerto {PORT}")
    app.run(host="0.0.0.0", port=PORT, threaded=True)
