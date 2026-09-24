#!/usr/bin/env python3
"""
local_tts_player.py — FASE 5: Cola de reproducción TTS local.

Arquitectura:
  - Proceso hijo de Node.js, corre en tts/venv (Kokoro instalado allí).
  - Lee comandos JSON línea por línea por stdin.
  - Escribe eventos JSON línea por línea por stdout.
  - Kokoro se carga una sola vez y permanece en memoria.
  - Cola interna con reproducción secuencial (un audio a la vez).
  - Reproduce por aplay (PipeWire/PulseAudio/ALSA de la laptop).

Protocolo stdin (comandos → este script):
  {"cmd":"speak","id":"uuid","text":"...","emotion":"feliz"}
  {"cmd":"cancel"}           # cancela el audio actual y vacía cola
  {"cmd":"ping"}
  {"cmd":"shutdown"}

Protocolo stdout (eventos ← este script):
  {"event":"ready"}
  {"event":"pong"}
  {"event":"tts_started","id":"uuid","text_length":42}
  {"event":"tts_generated","id":"uuid","duration_ms":3300}
  {"event":"playback_queued","id":"uuid","queue_length":1}
  {"event":"playback_started","id":"uuid"}
  {"event":"playback_completed","id":"uuid","duration_ms":3300}
  {"event":"playback_failed","id":"uuid","error":"..."}
  {"event":"cancelled","id":"uuid"}
  {"event":"shutdown_ack"}
"""

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import traceback
import wave
import tempfile
from pathlib import Path

# ─── Configuración ────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parents[1]
TTS_VENV_PYTHON = str(PROJECT_ROOT / "tts" / "venv" / "bin" / "python3")

AUDIO_SAMPLE_RATE = 24000  # Kokoro sample rate
AUDIO_CHANNELS = 1
AUDIO_SAMPLE_WIDTH = 2  # 16-bit

# ─── Estado global ────────────────────────────────────────────────
_tts_engine = None          # KokoroTTS instance
_play_queue = queue.Queue()  # (item_id, text, emotion, wav_bytes)
_current_id = None
_cancel_event = threading.Event()
_shutdown_event = threading.Event()
_playback_thread = None

# ─── Logging ──────────────────────────────────────────────────────
def log(msg):
    print(json.dumps({"event": "_log", "message": msg}), flush=True)


# ─── Kokoro wrapper (lazy import, resolves paths correctly) ───────
def _init_kokoro():
    global _tts_engine
    if _tts_engine is not None:
        return True

    try:
        # Add the project root so imports work
        sys.path.insert(0, str(PROJECT_ROOT))
        # Import directly bypassing tts/__init__.py (which has Auron deps)
        import importlib
        spec = importlib.util.spec_from_file_location(
            "kokoro_tts",
            str(PROJECT_ROOT / "tts" / "kokoro_tts.py")
        )
        kokoro_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(kokoro_mod)
        KokoroTTS = kokoro_mod.KokoroTTS

        _tts_engine = KokoroTTS()
        _tts_engine.ensure_loaded()
        log(f"Kokoro loaded: sample_rate={_tts_engine.sample_rate}")
        return True
    except Exception as e:
        log(f"Kokoro load error: {e}")
        traceback.print_exc(file=sys.stderr)
        return False


def _synthesize(text, emotion="feliz"):
    """Synthesize text to WAV bytes using Kokoro."""
    if _tts_engine is None:
        return None

    audio = _tts_engine.synthesize(text, emotion=emotion)
    if audio is None:
        return None

    import numpy as np
    if not isinstance(audio, np.ndarray) or audio.size == 0:
        return None

    # Normalize and convert to int16
    max_val = np.abs(audio).max()
    if max_val > 0:
        audio = audio / max_val * 0.95

    audio_int16 = (audio * 32767).clip(-32768, 32767).astype('int16')

    # Build WAV in memory
    buf = wave.open(io := __import__('io').BytesIO(), 'wb')
    buf.setnchannels(AUDIO_CHANNELS)
    buf.setsampwidth(AUDIO_SAMPLE_WIDTH)
    buf.setframerate(AUDIO_SAMPLE_RATE)
    buf.writeframes(audio_int16.tobytes())
    buf.close()

    return io.getvalue()


# ─── Playback worker ──────────────────────────────────────────────
def _emit(event, **data):
    payload = {"event": event}
    payload.update(data)
    print(json.dumps(payload), flush=True)


def _playback_worker():
    """Background thread: pulls from queue, plays via aplay."""
    while not _shutdown_event.is_set():
        try:
            item = _play_queue.get(timeout=0.5)
        except queue.Empty:
            continue

        item_id, text, emotion, wav_bytes = item
        _cancel_event.clear()

        # Synthesize
        _emit("tts_started", id=item_id, text_length=len(text))
        t0 = time.time()

        if wav_bytes is None:
            wav_bytes = _synthesize(text, emotion)
            if wav_bytes is None:
                _emit("playback_failed", id=item_id, error="synthesis returned None")
                _current_id = None
                continue

        duration_ms = int((time.time() - t0) * 1000)
        _emit("tts_generated", id=item_id, duration_ms=duration_ms)

        # Write temp WAV for aplay
        tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp_wav.write(wav_bytes)
        tmp_path = tmp_wav.name
        tmp_wav.close()

        # Queue
        _emit("playback_queued", id=item_id, queue_length=_play_queue.qsize() + 1)

        # Play
        _emit("playback_started", id=item_id)
        t1 = time.time()

        try:
            proc = subprocess.Popen(
                ["aplay", "-q", tmp_path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            # Wait for completion or cancellation
            while proc.poll() is None:
                if _cancel_event.is_set() or _shutdown_event.is_set():
                    proc.terminate()
                    try:
                        proc.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    _emit("cancelled", id=item_id)
                    break
                time.sleep(0.05)

            if proc.returncode == 0 and not _cancel_event.is_set():
                play_duration_ms = int((time.time() - t1) * 1000)
                _emit("playback_completed", id=item_id, duration_ms=play_duration_ms)
            elif not _cancel_event.is_set():
                _emit("playback_failed", id=item_id, error=f"aplay exit={proc.returncode}")

        except Exception as e:
            _emit("playback_failed", id=item_id, error=str(e))

        finally:
            _current_id = None
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ─── Command handler ──────────────────────────────────────────────
def _handle_command(cmd):
    global _current_id, _playback_thread

    cmd_type = cmd.get("cmd", "")

    if cmd_type == "speak":
        item_id = cmd.get("id", str(time.time()))
        text = cmd.get("text", "")
        emotion = cmd.get("emotion", "feliz")

        if not text:
            _emit("playback_failed", id=item_id, error="empty text")
            return

        _current_id = item_id
        _play_queue.put((item_id, text, emotion, None))

        # Ensure playback thread is running
        if _playback_thread is None or not _playback_thread.is_alive():
            _playback_thread = threading.Thread(target=_playback_worker, daemon=True)
            _playback_thread.start()

    elif cmd_type == "cancel":
        _cancel_event.set()
        # Clear queue
        while not _play_queue.empty():
            try:
                _play_queue.get_nowait()
            except queue.Empty:
                break
        _emit("cancelled", id=_current_id or "none")

    elif cmd_type == "ping":
        _emit("pong")

    elif cmd_type == "shutdown":
        _emit("shutdown_ack")
        _shutdown_event.set()
        _cancel_event.set()
        # Wait for playback thread to finish current item
        if _playback_thread and _playback_thread.is_alive():
            _playback_thread.join(timeout=10)
        # Flush and exit
        sys.stdout.flush()
        sys.exit(0)


# ─── Main ─────────────────────────────────────────────────────────
def main():
    # Signal handling for graceful shutdown
    signal.signal(signal.SIGINT, lambda s, f: sys.exit(0))
    signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))

    # Initialize Kokoro
    _emit("status", message="init:loading_kokoro")
    if not _init_kokoro():
        _emit("status", message="init:kokoro_failed")
        # Don't exit — allow fallback conversation with user even without TTS
    else:
        _emit("status", message="init:kokoro_ready")

    _emit("ready")
    sys.stdout.flush()

    # Read commands from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            _handle_command(cmd)
        except json.JSONDecodeError:
            _emit("error", message=f"invalid JSON: {line[:100]}")
        except Exception as e:
            _emit("error", message=str(e))
            traceback.print_exc(file=sys.stderr)


if __name__ == "__main__":
    main()
