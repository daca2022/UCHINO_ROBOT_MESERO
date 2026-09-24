import asyncio
import json
import logging
import os
import time
from typing import Optional

import numpy as np
import websockets
from websockets.asyncio.server import serve

from .noise_suppressor import DeepFilterNet3Suppressor
from .ser_branch import SERBranch
from wake_word.detector import WakeWordDetector

try:
    from ..turn_taking.turn_predictor import TurnPredictor
    HAS_TURN_TAKING = True
except ImportError:
    HAS_TURN_TAKING = False
    TurnPredictor = None

logger = logging.getLogger(__name__)

DEFAULT_UPSTREAM_HOST = os.getenv("WLK_HOST", "127.0.0.1")
DEFAULT_UPSTREAM_PORT = int(os.getenv("WLK_PORT", "8002"))
DEFAULT_LISTEN_PORT = int(os.getenv("PIPELINE_PORT", "8001"))
SAMPLE_RATE = 16000
SER_INTERVAL_SECONDS = 3.0

# Wake word configuration
WAKE_WORD = os.getenv("WAKE_WORD", "Oye Uchino")
WAKE_WORD_MODEL = os.getenv("WAKE_WORD_MODEL", "")
WAKE_WORD_THRESHOLD = float(os.getenv("WAKE_WORD_THRESHOLD", "0.5"))
WAKE_WORD_PATIENCE = int(os.getenv("WAKE_WORD_PATIENCE", "3"))
WAKE_WORD_ACTIVATION_TIMEOUT = float(os.getenv("WAKE_WORD_ACTIVATION_TIMEOUT", "15.0"))
DISABLE_WAKE_WORD = os.getenv("DISABLE_WAKE_WORD", "").lower() in ("1", "true", "yes")


class PipelineConnection:
    def __init__(self, client_ws, upstream_ws, suppressor, ser, wake_word_detector=None, turn_predictor=None):
        self.client_ws = client_ws
        self.upstream_ws = upstream_ws
        self.suppressor = suppressor
        self.ser = ser
        self.wake_word_detector = wake_word_detector
        self.turn_predictor = turn_predictor
        self.audio_buffer = bytearray()
        self.last_ser_time = 0.0
        self.latest_emotion: Optional[dict] = None
        self.closed = False
        self._ww_activated_this_connection = False

    async def _send_status(self, status_type: str, detail: str = ""):
        try:
            payload = {"type": "status", "status": status_type, "detail": detail}
            await self.client_ws.send(json.dumps(payload))
        except Exception:
            pass

    async def client_to_upstream(self):
        _audio_chunk_count = 0
        _first_audio_sent = False
        try:
            async for message in self.client_ws:
                if isinstance(message, bytes):
                    _audio_chunk_count += 1

                    if self.wake_word_detector:
                        ww_result = self.wake_word_detector.process_bytes(message)

                        if not self.wake_word_detector.is_activated():
                            if _audio_chunk_count % 50 == 1:
                                await self._send_status("listening", f"audio_chunks={_audio_chunk_count}")
                            continue

                        if not self._ww_activated_this_connection:
                            logger.info(
                                "[Pipeline] Wake word detected! Activating ASR pipeline"
                            )
                            self._ww_activated_this_connection = True
                            await self._send_status("wake_word", "activated")
                    else:
                        if not _first_audio_sent:
                            _first_audio_sent = True
                            await self._send_status("listening", "wake_word_disabled")

                    # Noise suppression bypassed for testing - causes transcription failures
                    cleaned = message  # self.suppressor.process_bytes(message, SAMPLE_RATE)
                    self.audio_buffer.extend(cleaned)
                    await self.upstream_ws.send(cleaned)
                    await self._maybe_run_ser()
                elif isinstance(message, str):
                    await self.upstream_ws.send(message)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.closed = True

    async def upstream_to_client(self):
        try:
            async for message in self.upstream_ws:
                if isinstance(message, bytes):
                    await self.client_ws.send(message)
                elif isinstance(message, str):
                    payload = json.loads(message)
                    if self.latest_emotion:
                        payload["emotion"] = self.latest_emotion
                    if self.wake_word_detector:
                        payload["wake_word"] = {
                            "state": self.wake_word_detector.state.value,
                            "activated": self.wake_word_detector.is_activated(),
                            "word": self.wake_word_detector.wake_word,
                        }
                    if self.turn_predictor:
                        payload["turn_taking"] = self._update_turn_taking(payload)
                        payload["customer_finished"] = payload["turn_taking"]["customer_finished"]
                    logger.debug("[Pipeline] Upstream message: %s", json.dumps(payload)[:200])
                    await self.client_ws.send(json.dumps(payload))
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.closed = True

    async def _maybe_run_ser(self):
        now = time.monotonic()
        if now - self.last_ser_time < SER_INTERVAL_SECONDS:
            return
        min_bytes = SAMPLE_RATE * 2 * 1
        if len(self.audio_buffer) < min_bytes:
            return
        audio_arr = np.frombuffer(self.audio_buffer, dtype=np.int16).astype(np.float32) / 32768.0
        result = await asyncio.to_thread(self.ser.process, audio_arr, SAMPLE_RATE)
        if result:
            self.latest_emotion = result
            logger.debug("[SER] Detected emotion: %s", result["emotion"])
        self.last_ser_time = now

    @staticmethod
    def _parse_time_to_seconds(time_str: Optional[str]) -> float:
        if not time_str:
            return 0.0
        parts = time_str.split(":")
        if len(parts) == 3:
            h, m, s = parts
            return float(h) * 3600 + float(m) * 60 + float(s)
        return 0.0

    def _update_turn_taking(self, payload: dict) -> dict:
        lines = payload.get("lines", [])
        latest_transcript = ""
        silence_count = 0
        last_silence_duration_ms = 0.0

        for seg in reversed(lines):
            speaker = seg.get("speaker", -1)
            text = (seg.get("text") or "").strip()
            if speaker == -2:
                silence_count += 1
                if last_silence_duration_ms == 0.0:
                    start = self._parse_time_to_seconds(seg.get("start"))
                    end = self._parse_time_to_seconds(seg.get("end"))
                    last_silence_duration_ms = max(0.0, (end - start) * 1000.0)
            elif text and not latest_transcript:
                latest_transcript = text

        if not latest_transcript:
            buffer = payload.get("buffer_transcription", "")
            if buffer:
                latest_transcript = buffer.strip()

        if latest_transcript:
            self.turn_predictor.process_audio_frame(
                is_speech=True, transcript=latest_transcript,
            )

        if silence_count > 0 and last_silence_duration_ms > 0:
            result = self.turn_predictor.process_silence(
                duration_ms=last_silence_duration_ms,
                transcript=latest_transcript,
                silence_count=silence_count,
            )
        elif latest_transcript:
            result = self.turn_predictor.process_silence(
                duration_ms=0.0,
                transcript=latest_transcript,
                silence_count=0,
            )
        else:
            result = self.turn_predictor.process_silence(
                duration_ms=0.0, transcript="", silence_count=0,
            )

        return {
            "customer_finished": result.customer_finished,
            "confidence": round(result.confidence, 3),
            "reason": result.reason,
            "silence_duration_ms": round(result.silence_duration_ms, 0),
            "pause_count": result.pause_count,
            "transcript": result.transcript,
        }

    async def cleanup(self):
        self.closed = True
        for ws in (self.client_ws, self.upstream_ws):
            try:
                await ws.close()
            except Exception:
                pass


class AudioPipelineManager:
    def __init__(
        self,
        listen_port: int = DEFAULT_LISTEN_PORT,
        upstream_host: str = DEFAULT_UPSTREAM_HOST,
        upstream_port: int = DEFAULT_UPSTREAM_PORT,
        enable_wake_word: bool = not DISABLE_WAKE_WORD,
    ):
        self.listen_port = listen_port
        self.upstream_url = f"ws://{upstream_host}:{upstream_port}/asr"
        self.suppressor = DeepFilterNet3Suppressor()
        self.ser = SERBranch()
        self.server = None

        # Initialize wake word detector (lightweight, always running)
        if enable_wake_word:
            model_path = os.getenv("WAKE_WORD_MODEL_PATH") or None
            self.wake_word_detector = WakeWordDetector(
                wake_word=WAKE_WORD,
                model_path=model_path,
                threshold=WAKE_WORD_THRESHOLD,
                patience=WAKE_WORD_PATIENCE,
                activation_timeout=WAKE_WORD_ACTIVATION_TIMEOUT,
            )
            logger.info(
                "[Pipeline] Wake word detection enabled: '%s' "
                "(threshold=%.2f, patience=%d, timeout=%.1fs)",
                WAKE_WORD,
                WAKE_WORD_THRESHOLD,
                WAKE_WORD_PATIENCE,
                WAKE_WORD_ACTIVATION_TIMEOUT,
            )
        else:
            self.wake_word_detector = None
            logger.info("[Pipeline] Wake word detection disabled")

        if HAS_TURN_TAKING:
            self.turn_predictor = TurnPredictor()
            logger.info(
                "[Pipeline] Turn-taking prediction enabled "
                "(silence_threshold=%.0fms, spanish_mode=True)",
                self.turn_predictor.silence_threshold_ms,
            )
        else:
            self.turn_predictor = None
            logger.info("[Pipeline] Turn-taking prediction disabled")

    async def _handle_client(self, client_ws):
        path = getattr(client_ws, "path", None) or (getattr(client_ws.request, "path", None) if hasattr(client_ws, "request") else None) or "/asr"
        per_conn_disable_ww = "no_wake_word=1" in path or "no_wake_word=true" in path
        wake_word_detector = None if per_conn_disable_ww else self.wake_word_detector
        upstream_url = self.upstream_url
        logger.info("[Pipeline] Client connected (%s). wake_word=%s. Proxying to %s", path, "disabled" if per_conn_disable_ww else "enabled", upstream_url)
        try:
            upstream_ws = await websockets.connect(upstream_url)
        except Exception as e:
            logger.error("[Pipeline] Cannot connect to upstream %s: %s", upstream_url, e)
            await client_ws.close()
            return

        conn = PipelineConnection(
            client_ws,
            upstream_ws,
            self.suppressor,
            self.ser,
            wake_word_detector=wake_word_detector,
            turn_predictor=self.turn_predictor,
        )
        tasks = [
            asyncio.create_task(conn.client_to_upstream()),
            asyncio.create_task(conn.upstream_to_client()),
        ]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            await conn.cleanup()
            for t in tasks:
                t.cancel()
            logger.info("[Pipeline] Client disconnected")

    async def start(self):
        logger.info("[Pipeline] Starting server on port %d", self.listen_port)
        self.server = await serve(self._handle_client, "0.0.0.0", self.listen_port)
        logger.info("[Pipeline] Listening on ws://0.0.0.0:%d/asr", self.listen_port)

    async def stop(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            logger.info("[Pipeline] Server stopped")

    def run(self):
        asyncio.run(self._run())

    async def _run(self):
        await self.start()
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            pass
        finally:
            await self.stop()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    logging.getLogger("wake_word").setLevel(logging.DEBUG)
    manager = AudioPipelineManager()
    manager.run()
