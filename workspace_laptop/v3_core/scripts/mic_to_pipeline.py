"""
Debug tool: capture laptop mic audio → pipeline → shows transcription in real-time.

Usage: source WhisperLiveKit/venv/bin/activate && python3 scripts/mic_to_pipeline.py
"""

import asyncio
import json
import logging
import sys
import numpy as np
import sounddevice as sd
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("mic")

PIPELINE_URL = "ws://localhost:8001/asr"
SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_MS = 100
CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS // 1000


class MicDebugger:
    def __init__(self):
        self.ws = None
        self._running = False
        self._audio_queue = asyncio.Queue()

    async def start(self):
        self._running = True
        print("\n" + "=" * 60)
        print("  CHIPI MIC DEBUGGER")
        print("=" * 60)
        print(f"  Pipeline: {PIPELINE_URL}")
        print(f"  Mic: {sd.query_devices(kind='input')['name']}")
        print("=" * 60)
        print()
        print("  Di 'Oye Uchino' para activar el robot.")
        print("  Habla y mira la transcripcion en tiempo real.")
        print("  Ctrl+C para salir.")
        print()
        print("-" * 60)

        try:
            async with websockets.connect(PIPELINE_URL, max_size=None) as ws:
                self.ws = ws
                logger.info("Conectado al pipeline")

                stream = sd.InputStream(
                    samplerate=SAMPLE_RATE,
                    channels=CHANNELS,
                    dtype="int16",
                    blocksize=CHUNK_SAMPLES,
                    callback=self._audio_callback,
                )

                with stream:
                    await asyncio.gather(
                        self._send_audio(),
                        self._receive_messages(),
                    )

        except websockets.ConnectionClosed as e:
            logger.error(f"Conexion cerrada: {e}")
        except Exception as e:
            logger.error(f"Error: {e}")
        finally:
            self._running = False
            print("\n  Saliendo...")

    def _audio_callback(self, indata, frames, time_info, status):
        if status:
            logger.warning(f"Audio status: {status}")
        try:
            self._audio_queue.put_nowait(indata.tobytes())
        except asyncio.QueueFull:
            pass

    async def _send_audio(self):
        while self._running:
            try:
                data = await asyncio.wait_for(self._audio_queue.get(), timeout=0.5)
                if self.ws:
                    await self.ws.send(data)
            except asyncio.TimeoutError:
                continue
            except Exception as e:
                logger.error(f"Send error: {e}")
                break

    async def _receive_messages(self):
        while self._running:
            try:
                msg = await asyncio.wait_for(self.ws.recv(), timeout=0.5)
                self._display(msg)
            except asyncio.TimeoutError:
                continue
            except websockets.ConnectionClosed:
                break
            except Exception as e:
                logger.error(f"Recv error: {e}")
                break

    def _display(self, raw: str):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return

        t = data.get("type", "")
        status = data.get("status", "")

        if t == "status":
            s = data.get("status", "")
            detail = data.get("detail", "")
            if s == "listening":
                print("  [mic] Escuchando... (audio llegando al pipeline)", end="\r", flush=True)
            elif s == "wake_word":
                print("\n\n  *** WAKE WORD DETECTADO ***")
                print("  Habla tu orden ahora:")
                print("  " + "-" * 40)

        elif status == "active_transcription":
            lines = data.get("lines", [])
            buf = data.get("buffer_transcription", "")
            if lines:
                last = lines[-1]
                text = last.get("text", "") if isinstance(last, dict) else str(last)
                if text:
                    print(f"\n  [transcripcion] {text}")
                    print("  " + "-" * 40)
            elif buf:
                print(f"  [buffer] {buf}", end="\r", flush=True)

        elif status == "no_audio_detected":
            pass  # silent — expected when no one is speaking

        elif t == "wake_word":
            state = data.get("state", "")
            if state == "activated":
                print("\n\n  *** WAKE WORD ACTIVADO ***")
                print("  Habla tu orden ahora:")
                print("  " + "-" * 40)
            elif state == "timeout":
                print("\n  [timeout] Robot duerme de nuevo")

        elif t == "emotion":
            emo = data.get("emotion", {})
            label = emo.get("label", "")
            conf = emo.get("confidence", 0)
            if label and conf > 0.3:
                print(f"  [emotion] {label} ({conf:.0%})")

        elif t == "ready_to_stop":
            print("\n  [whisper] Procesamiento completado")

        elif t == "error":
            print(f"  [error] {data.get('error', '?')}")


if __name__ == "__main__":
    try:
        asyncio.run(MicDebugger().start())
    except KeyboardInterrupt:
        pass
