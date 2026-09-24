#!/usr/bin/env python3
"""
stream_laptop_mic.py — Streaming laptop mic to WhisperLiveKit via persistent WebSocket.

Captures laptop mic in real-time, sends PCM frames, receives partial/final
transcriptions with latency metrics. Handles VAD-based turn boundaries.

Usage:
    python3 tools/stream_laptop_mic.py --duration 30
"""

import asyncio
import json
import logging
import sys
import time
import argparse
import queue
import uuid
from datetime import datetime

import numpy as np
import sounddevice as sd
import websockets
import httpx

SAMPLE_RATE = 16000
CHANNELS = 1
DTYPE = np.int16
BLOCK_SIZE = 3200  # 200ms @ 16kHz

VAD_SPEECH_THRESHOLD = 4000
VAD_SILENCE_FRAMES_MAX = 15  # 15 * 200ms = 3s silence (más natural)
VAD_MIN_TURN_MS = 500
VAD_MAX_TURN_MS = 15000

STATE_IDLE = "IDLE"
STATE_LISTENING = "LISTENING"
STATE_PROCESSING = "PROCESSING"


class LaptopMicStreamer:
    def __init__(self, whisper_port=8002, session_id=None, log_path=None, mesa="9"):
        self.whisper_url = f"ws://127.0.0.1:{whisper_port}/asr"
        self.backend_url = "http://127.0.0.1:3005"
        self.session_id = session_id or f"laptop_{int(time.time())}"
        self.mesa = mesa
        self.client_id = str(uuid.uuid4())
        self.ws = None
        self.connected = False

        self.state = STATE_IDLE
        self.turn_id = 0
        self.current_turn_start = 0
        self.current_turn_text = ""
        self.silence_frame_count = 0
        self.total_audio_frames = 0
        self.audio_buffer = bytearray()

        self.stats = {
            "frames_sent": 0,
            "bytes_sent": 0,
            "partials_received": 0,
            "finals_received": 0,
            "turns_completed": 0,
            "last_partial_latency_ms": 0,
            "last_final_latency_ms": 0,
            "last_partial_text": "",
            "last_final_text": "",
            "connection_start": 0,
            "errors": [],
        }

        self.audio_queue = queue.Queue(maxsize=100)
        self._last_partial = ""
        self._last_final = ""
        self._cooldown_until = 0

        self.logger = logging.getLogger("MicStream")
        handler = logging.FileHandler(log_path) if log_path else logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter(
            "%(asctime)s.%(msecs)03d [%(levelname)s] %(message)s",
            datefmt="%H:%M:%S"
        ))
        self.logger.addHandler(handler)
        self.logger.setLevel(logging.DEBUG)
        self.logger.propagate = False

    def log(self, level, msg):
        getattr(self.logger, level)(msg)

    async def connect_whisper(self):
        self.log("info", f"[CONNECT] Conectando a {self.whisper_url} ...")
        self.stats["connection_start"] = time.time()
        try:
            self.ws = await websockets.connect(
                self.whisper_url, ping_interval=30, ping_timeout=10, max_size=2**20,
            )
            self.connected = True
            self.log("info", f"[CONNECT] Conectado a WhisperLiveKit")
            self.log("info", f"[SESSION] session_id={self.session_id}")
            return True
        except Exception as e:
            self.log("error", f"[CONNECT] Error: {e}")
            self.stats["errors"].append(f"connect: {e}")
            return False

    async def disconnect_whisper(self):
        if self.ws:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None
        self.connected = False

    def audio_callback(self, indata, frame_count, time_info, status):
        if status:
            self.log("warning", f"[MIC] Status: {status}")
        try:
            self.audio_queue.put_nowait(indata.copy())
        except queue.Full:
            pass

    async def send_loop(self):
        loop = asyncio.get_event_loop()
        while True:
            try:
                indata = await loop.run_in_executor(
                    None, lambda: self.audio_queue.get(timeout=0.1)
                )
            except queue.Empty:
                if self.stats["errors"] and self.state == STATE_IDLE:
                    break
                continue

            pcm_bytes = indata.tobytes()
            self.total_audio_frames += 1
            self.stats["frames_sent"] += 1
            self.stats["bytes_sent"] += len(pcm_bytes)

            rms = np.sqrt(np.mean(indata.astype(np.float32)**2))

            if self.state == STATE_IDLE and rms > VAD_SPEECH_THRESHOLD and time.time() > self._cooldown_until:
                self.turn_id += 1
                self.current_turn_start = time.time()
                self.current_turn_text = ""
                self.silence_frame_count = 0
                self.audio_buffer.clear()
                self._last_final = ""
                self._last_partial = ""
                self.state = STATE_LISTENING
                self.log("info", f"[TURN] turn_id={self.turn_id} iniciado")

            if self.state == STATE_LISTENING:
                self.audio_buffer.extend(pcm_bytes)
                # Reconnect per turn to avoid Whisper context contamination
                if not self.connected:
                    self.log("debug", "[SEND] Reconectando Whisper para nuevo turno...")
                    await self.connect_whisper()
                if self.connected and self.ws:
                    try:
                        await self.ws.send(bytes(pcm_bytes))
                    except Exception as e:
                        self.log("error", f"[SEND] Error: {e}")
                        self.stats["errors"].append(f"send: {e}")

                if rms < VAD_SPEECH_THRESHOLD:
                    self.silence_frame_count += 1
                    if self.silence_frame_count >= VAD_SILENCE_FRAMES_MAX:
                        elapsed_ms = (time.time() - self.current_turn_start) * 1000
                        if elapsed_ms >= VAD_MIN_TURN_MS:
                            self.state = STATE_PROCESSING
                            self.log("info", "[VAD] Silencio detectado — turno finalizado")
                            text = self.stats["last_final_text"] or self.current_turn_text or "(sin texto)"
                            self.log("info",
                                f"[TURN] FINAL ({elapsed_ms:.0f}ms): \"{text}\"")
                            self.stats["turns_completed"] += 1
                            # Enviar a ASR endpoint si hay texto válido
                            if text and text != "(sin texto)":
                                await self.send_to_asr(text)
                            self.state = STATE_IDLE
                            self._cooldown_until = time.time() + 2.0
                            self.current_turn_text = ""
                            self._last_final = ""
                            self._last_partial = ""
                            # Close connection to clean Whisper context for next turn
                            await self.disconnect_whisper()
                            self.log("debug", "[SEND] Conexión Whisper cerrada para limpiar contexto")
                else:
                    self.silence_frame_count = 0

                if self.state == STATE_LISTENING:
                    elapsed_ms = (time.time() - self.current_turn_start) * 1000
                    if elapsed_ms > VAD_MAX_TURN_MS:
                        self.state = STATE_PROCESSING
                        text = self.current_turn_text or "(timeout)"
                        self.log("info",
                            f"[TURN] TIMEOUT ({elapsed_ms:.0f}ms): \"{text}\"")
                        self.stats["turns_completed"] += 1
                        self.state = STATE_IDLE
                        self._cooldown_until = time.time() + 1.0
                        self.current_turn_text = ""

            if self.total_audio_frames % 25 == 0:
                self.log("debug",
                    f"[STATS] f={self.stats['frames_sent']} "
                    f"p={self.stats['partials_received']} "
                    f"F={self.stats['finals_received']} "
                    f"T={self.stats['turns_completed']} "
                    f"s={self.state}"
                )

    async def receive_loop(self):
        while self.turn_id > 0 or not self.stats["errors"]:
            try:
                if not self.ws:
                    await asyncio.sleep(0.05)
                    continue
                async for raw in self.ws:
                    if isinstance(raw, bytes):
                        continue
                    try:
                        msg = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    # Skip config messages (sent by Whisper on new connection)
                    if msg.get("type") == "config":
                        continue

                    lines = msg.get("lines", [])
                    confirmed_text = ""
                    if lines:
                        confirmed_text = " ".join(
                            l["text"] if isinstance(l, dict) else l.text for l in lines
                        )
                    buffer_text = msg.get("buffer_transcription", "") or msg.get("text", "")

                    if not confirmed_text and not buffer_text:
                        continue

                    now_ms = time.time() * 1000
                    turn_start_ms = self.current_turn_start * 1000 if self.current_turn_start else now_ms

                    if confirmed_text and confirmed_text != self._last_final:
                        latency = now_ms - turn_start_ms
                        self.stats["finals_received"] += 1
                        self.stats["last_final_latency_ms"] = latency
                        self.stats["last_final_text"] = confirmed_text
                        self._last_final = confirmed_text
                        self.log("info",
                            f"[ASR_FINAL] \"{confirmed_text}\" ({latency:.0f}ms)")

                    if buffer_text:
                        latency = now_ms - turn_start_ms
                        self.stats["partials_received"] += 1
                        self.stats["last_partial_latency_ms"] = latency
                        self.stats["last_partial_text"] = buffer_text
                        self.current_turn_text = buffer_text
                        if buffer_text != self._last_partial:
                            self.log("info",
                                f"[ASR_PARTIAL] \"{buffer_text}\" ({latency:.0f}ms)")
                            self._last_partial = buffer_text

            except websockets.exceptions.ConnectionClosed:
                self.log("debug", "[RECV] Conexión cerrada (esperado en entre-turnos)")
                await asyncio.sleep(0.05)
            except Exception as e:
                self.log("error", f"[RECV] Error: {e}")
                self.stats["errors"].append(f"recv: {e}")
                break

    async def stream_from_mic(self, duration=30):
        self.log("info", f"[MIC] {SAMPLE_RATE}Hz {CHANNELS}ch block={BLOCK_SIZE}")
        self.log("info", f"[MIC] VAD: threshold={VAD_SPEECH_THRESHOLD} silence_ms={VAD_SILENCE_FRAMES_MAX*200}")

        if not await self.connect_whisper():
            return

        send_task = asyncio.create_task(self.send_loop())
        recv_task = asyncio.create_task(self.receive_loop())

        try:
            stream = sd.InputStream(
                samplerate=SAMPLE_RATE, channels=CHANNELS, dtype=DTYPE,
                blocksize=BLOCK_SIZE, callback=self.audio_callback,
            )
            with stream:
                self.log("info", "[MIC] Streaming iniciado — habla ahora!")
                await asyncio.sleep(duration)
        except KeyboardInterrupt:
            pass
        except Exception as e:
            self.log("error", f"[MIC] Error: {e}")
            self.stats["errors"].append(f"mic: {e}")
        finally:
            send_task.cancel()
            recv_task.cancel()
            try:
                await asyncio.gather(send_task, recv_task, return_exceptions=True)
            except Exception:
                pass
            await self.disconnect_whisper()

        self.print_summary()

    async def send_to_asr(self, text):
        """Envía transcripción final a POST /api/asr/process y muestra la respuesta."""
        turn = self.turn_id  # ya incrementado por VAD en send_loop
        payload = {
            "user_text": text,
            "session_id": self.session_id,
            "source": "laptop_microphone",
            "mesa": self.mesa,
            "client_id": self.client_id,
            "turn_id": turn,
        }
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                self.log("info", f"[ASR] Enviando a backend (turno {turn})...")
                resp = await client.post(f"{self.backend_url}/api/asr/process", json=payload)
                if resp.status_code != 200:
                    self.log("error", f"[ASR] Error {resp.status_code}: {resp.text[:200]}")
                    return
                data = resp.json()
                llm_text = data.get("text", "")
                state = data.get("state", "")
                order_id = data.get("order_id", "")
                confirmed = data.get("confirmed", False)
                model = data.get("model", "")
                paid = data.get("paid", False)

                self.log("info", f"[UCHINO] 🤖 {llm_text}")
                self.log("info", f"[ASR] state={state} order={order_id[:8] if order_id else '—'} "
                                 f"paid={paid} model={model[:30] if model else '—'}")
                if confirmed:
                    self.log("info", f"[COCINA] ✅ Pedido confirmado y enviado a cocina!")
        except Exception as e:
            self.log("error", f"[ASR] Error de conexión: {e}")

    def print_summary(self):
        elapsed = time.time() - self.stats["connection_start"]
        self.log("info", "=" * 60)
        self.log("info", "RESUMEN DE SESIÓN")
        self.log("info", f"  Sesión:         {self.session_id}")
        self.log("info", f"  Duración:       {elapsed:.1f}s")
        self.log("info", f"  Frames:         {self.stats['frames_sent']}")
        self.log("info", f"  Bytes:          {self.stats['bytes_sent']}")
        self.log("info", f"  Parciales:      {self.stats['partials_received']}")
        self.log("info", f"  Finales:        {self.stats['finals_received']}")
        self.log("info", f"  Turnos:         {self.stats['turns_completed']}")
        self.log("info", f"  Última parcial: {self.stats['last_partial_latency_ms']:.0f}ms")
        self.log("info", f"  Última final:   {self.stats['last_final_latency_ms']:.0f}ms")
        if self.stats["errors"]:
            self.log("info", f"  Errores ({len(self.stats['errors'])}):")
            for e in self.stats["errors"][-5:]:
                self.log("info", f"    - {e}")
        self.log("info", "=" * 60)


def main():
    parser = argparse.ArgumentParser(description="Stream laptop mic to WhisperLiveKit")
    parser.add_argument("--duration", type=int, default=120, help="Recording duration (s)")
    parser.add_argument("--port", type=int, default=8002, help="WhisperLiveKit port")
    parser.add_argument("--log", type=str, default="", help="Log file path")
    parser.add_argument("--session", type=str, default="", help="Session ID")
    parser.add_argument("--mesa", type=str, default="9", help="Mesa number")
    args = parser.parse_args()

    streamer = LaptopMicStreamer(
        whisper_port=args.port,
        session_id=args.session or f"laptop_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
        log_path=args.log or None,
        mesa=args.mesa,
    )
    asyncio.run(streamer.stream_from_mic(duration=args.duration))


if __name__ == "__main__":
    main()
