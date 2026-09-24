#!/usr/bin/env python3
"""
Mic Capture — Captura audio del micrófono laptop y lo envía al pipeline de voz.

Modos:
  1. pipeline  → envía a audio_pipeline (ws://localhost:8001/asr) → WhisperLiveKit → backend
  2. raw       → guarda archivo WAV y envía a backend para transcripción offline
  3. both      → pipeline + raw simultáneo

Uso:
  python scripts/mic_capture.py [modo]
  python scripts/mic_capture.py raw    # guarda WAV
  python scripts/mic_capture.py both   # pipeline + WAV
"""

import argparse
import asyncio
import json
import logging
import os
import signal
import struct
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import sounddevice as sd

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [MIC] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("mic_capture")

SAMPLE_RATE = 16000
CHANNELS = 1
BLOCK_SIZE = 1600  # 100ms @ 16kHz
PIPELINE_URL = os.getenv("PIPELINE_URL", "ws://127.0.0.1:8001/asr")
BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:3005")


class MicCapture:
    def __init__(self, mode="pipeline", device=None):
        self.mode = mode
        self.device = device
        self.running = False
        self.ws = None
        self.audio_buffer = bytearray()
        self.recording = []
        self.wav_dir = Path(tempfile.gettempdir()) / "chipi_mic"

    async def connect_pipeline(self):
        """Conecta al WebSocket del audio_pipeline."""
        import websockets

        for attempt in range(5):
            try:
                self.ws = await websockets.connect(PIPELINE_URL, ping_interval=None)
                logger.info("Conectado a audio_pipeline en %s", PIPELINE_URL)
                return True
            except Exception as e:
                logger.warning(
                    "Intento %d/5: No se pudo conectar a %s: %s",
                    attempt + 1, PIPELINE_URL, e,
                )
                if attempt < 4:
                    await asyncio.sleep(2)
        return False

    def audio_callback(self, indata, frames, time_info, status):
        """Callback de sounddevice — se llama con cada bloque de audio."""
        if status:
            logger.warning("Status: %s", status)

        # Convertir float32 [-1, 1] a int16 PCM
        pcm = (indata[:, 0] * 32767).astype(np.int16).tobytes()
        self.audio_buffer.extend(pcm)

        if self.mode in ("raw", "both"):
            self.recording.append(indata.copy())

    async def stream_to_pipeline(self):
        """Envía buffer de audio al pipeline en tiempo real."""
        while self.running:
            if len(self.audio_buffer) >= BLOCK_SIZE:
                chunk = bytes(self.audio_buffer[:BLOCK_SIZE])
                self.audio_buffer = self.audio_buffer[BLOCK_SIZE:]
                try:
                    if self.ws:
                        await self.ws.send(chunk)
                except Exception as e:
                    logger.error("Error enviando a pipeline: %s", e)
                    self.ws = None
                    break
            await asyncio.sleep(0.01)

    async def listen_pipeline(self):
        """Escucha respuestas del pipeline (transcripciones, emociones)."""
        while self.running and self.ws:
            try:
                msg = await asyncio.wait_for(self.ws.recv(), timeout=0.5)
                try:
                    data = json.loads(msg)
                    if data.get("status") == "transcription":
                        text = data.get("text", "")
                        if text:
                            logger.info("TRANSCRIPCION: %s", text)
                            # Enviar al backend
                            await self.send_to_backend(text)
                    elif data.get("type") == "emotion":
                        logger.info("EMOCION: %s", data.get("emotion"))
                except json.JSONDecodeError:
                    pass
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                if self.running:
                    logger.error("Error en pipeline: %s", e)
                break

    async def send_to_backend(self, text):
        """Envía texto transcrito al backend LLM."""
        import aiohttp

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    f"{BACKEND_URL}/api/llm/chat",
                    json={"message": text, "mode": "voz"},
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as resp:
                    if resp.ok:
                        data = await resp.json()
                        reply = data.get("text", "")
                        if reply:
                            logger.info("CHIPI: %s", reply)
                            # Trigger TTS via backend
                            await session.post(
                                f"{BACKEND_URL}/api/tts/speak",
                                json={"text": reply},
                                timeout=aiohttp.ClientTimeout(total=30),
                            )
                    else:
                        logger.warning("Backend error: %d", resp.status)
        except ImportError:
            # aiohttp no instalado, usar requests
            import urllib.request
            import urllib.error

            req = urllib.request.Request(
                f"{BACKEND_URL}/api/llm/chat",
                data=json.dumps({"message": text, "mode": "voz"}).encode(),
                headers={"Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read())
                    reply = data.get("text", "")
                    if reply:
                        logger.info("CHIPI: %s", reply)
            except Exception as e:
                logger.warning("Backend error: %s", e)
        except Exception as e:
            logger.warning("Backend error: %s", e)

    def save_wav(self, audio_data, filename=None):
        """Guarda audio capturado como WAV."""
        self.wav_dir.mkdir(parents=True, exist_ok=True)
        if filename is None:
            filename = f"chipi_{int(time.time())}.wav"
        path = self.wav_dir / filename

        import soundfile as sf
        sf.write(str(path), audio_data, SAMPLE_RATE)
        logger.info("Audio guardado: %s (%.1fs)", path, len(audio_data) / SAMPLE_RATE)
        return path

    async def run(self):
        self.running = True
        logger.info("Iniciando captura de micrófono...")
        logger.info("Modo: %s | Sample rate: %d | Device: %s",
                    self.mode, SAMPLE_RATE, self.device or "default")

        if self.mode in ("pipeline", "both"):
            connected = await self.connect_pipeline()
            if not connected:
                logger.warning(
                    "No se pudo conectar al pipeline. "
                    "Asegúrate de que audio_pipeline esté corriendo: "
                    "bash start_pipeline.sh"
                )
                if self.mode == "pipeline":
                    logger.info("Cambiando a modo 'raw' (solo grabación)")
                    self.mode = "raw"

        # Configurar stream de audio
        stream = sd.InputStream(
            device=self.device,
            channels=CHANNELS,
            samplerate=SAMPLE_RATE,
            blocksize=BLOCK_SIZE,
            callback=self.audio_callback,
        )

        # Iniciar tasks
        tasks = []
        if self.mode in ("pipeline", "both") and self.ws:
            tasks.append(asyncio.create_task(self.stream_to_pipeline()))
            tasks.append(asyncio.create_task(self.listen_pipeline()))

        logger.info("Grabando... Presiona Ctrl+C para detener")
        logger.info("Audio pipeline: %s", PIPELINE_URL)
        logger.info("Backend LLM: %s", BACKEND_URL)

        with stream:
            try:
                await asyncio.Event().wait()  # corre hasta Ctrl+C
            except asyncio.CancelledError:
                pass

        self.running = False

        # Guardar grabación si hay datos
        if self.recording:
            audio_data = np.concatenate(self.recording, axis=0)
            wav_path = self.save_wav(audio_data)
            logger.info("Grabación guardada: %s", wav_path)

        logger.info("Captura finalizada")


def main():
    parser = argparse.ArgumentParser(description="Captura de micrófono para Chipi")
    parser.add_argument(
        "mode", nargs="?", default="pipeline",
        choices=["pipeline", "raw", "both"],
        help="Modo de operación (default: pipeline)",
    )
    parser.add_argument("--device", type=int, default=None, help="ID del dispositivo de audio")
    args = parser.parse_args()

    capture = MicCapture(mode=args.mode, device=args.device)

    try:
        asyncio.run(capture.run())
    except KeyboardInterrupt:
        logger.info("Detenido por usuario")


if __name__ == "__main__":
    main()
