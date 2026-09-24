"""
TTS Manager — Primary/fallback switching between Kokoro and Piper.

Strategy:
  - Primary: Kokoro (KokoroTTS) — emotional style control, 0.3 GB VRAM
  - Fallback: Piper (subprocess, Node.js PiperTTSService via REST API)
  - Auto-fallback when Kokoro unavailable or errors
  - Kokoro unloads after 30s idle to keep VRAM < 2 GB at all times

Integration:
  - Called from backend_api (Express) via HTTP POST /api/tts/synthesize
  - Returns base64-encoded WAV audio
  - Compatible with existing audio_pipeline output format
"""

import base64
import io
import logging
import struct
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional, Dict

import numpy as np

from .kokoro_tts import KokoroTTS, EMOTION_STYLE_MAP, KOKORO_SAMPLE_RATE
from .auron_voice import AuronVoice

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Piper fallback configuration
# ---------------------------------------------------------------------------
_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_PIPER_BIN = "/home/david/.local/bin/piper"
_DEFAULT_PIPER_MODEL = str(
    _PROJECT_ROOT / "models" / "piper" / "es_ES-davefx-medium.onnx"
)
_DEFAULT_PIPER_CONFIG = str(
    _PROJECT_ROOT / "models" / "piper" / "es_ES-davefx-medium.onnx.json"
)
_PIPER_SAMPLE_RATE = 22050


class TTSManager:
    """Orchestrates TTS with primary (Kokoro) and fallback (Piper) engines.

    Usage:
        mgr = TTSManager()
        wav_b64 = mgr.synthesize("¡Hola!", emotion="feliz")
        # Returns base64 WAV string or empty string on total failure
    """

    def __init__(
        self,
        piper_bin: str = _DEFAULT_PIPER_BIN,
        piper_model: str = _DEFAULT_PIPER_MODEL,
        piper_config: str = _DEFAULT_PIPER_CONFIG,
        auron_enabled: bool = False,
    ):
        self._piper_bin = piper_bin
        self._piper_model = piper_model
        self._piper_config = piper_config

        self._kokoro = KokoroTTS()
        self._kokoro_available: Optional[bool] = None
        self._piper_available: Optional[bool] = None
        self._auron_enabled = auron_enabled
        self._auron_instance = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def sample_rate(self) -> int:
        return KOKORO_SAMPLE_RATE

    @property
    def kokoro_available(self) -> bool:
        if self._kokoro_available is None:
            self._kokoro_available = self._kokoro.ensure_loaded()
        return self._kokoro_available

    @property
    def piper_available(self) -> bool:
        if self._piper_available is None:
            self._piper_available = self._check_piper()
        return self._piper_available

    @property
    def auron_enabled(self) -> bool:
        return self._auron_enabled

    @auron_enabled.setter
    def auron_enabled(self, value: bool) -> None:
        self._auron_enabled = value

    @property
    def _auron(self) -> Optional[AuronVoice]:
        if not self._auron_enabled:
            return None
        if self._auron_instance is None:
            try:
                self._auron_instance = AuronVoice()
                logger.info("Auron RVC voice conversion activated")
            except Exception as exc:
                logger.error("Failed to initialize Auron RVC: %s", exc)
                self._auron_enabled = False
        return self._auron_instance

    def synthesize(
        self,
        text: str,
        emotion: Optional[str] = None,
        output_format: str = "wav_base64",
    ) -> Optional[str]:
        """Synthesize speech and return as base64 WAV.

        Priority: Kokoro → Piper → None (empty response).

        Args:
            text: Spanish text to speak.
            emotion: Chipi emotion tag (feliz, triste, etc.).
            output_format: "wav_base64" (default) or "pcm_f32".

        Returns:
            Base64-encoded WAV string or None on total failure.
        """
        if not text or not text.strip():
            logger.warning("TTSManager.synthesize called with empty text")
            return None

        text = text.strip()
        audio = None

        if self.kokoro_available:
            audio = self._kokoro.synthesize(text, emotion=emotion)

        if audio is None and self.piper_available:
            logger.info("Kokoro unavailable — falling back to Piper TTS")
            audio = self._synthesize_piper(text)

        if audio is None or len(audio) == 0:
            logger.error("TTS failed for text: %r", text[:80])
            return None

        auron = self._auron
        if auron is not None:
            try:
                sr = KOKORO_SAMPLE_RATE
                audio = auron.convert(audio, sr)
            except Exception as exc:
                logger.error("Auron RVC post-processing failed: %s", exc)

        if output_format == "pcm_f32":
            return audio.tobytes().hex() if isinstance(audio, np.ndarray) else None

        return self._audio_to_wav_base64(audio)

    def synthesize_with_engine(
        self,
        text: str,
        emotion: Optional[str] = None,
        force_engine: Optional[str] = None,
    ) -> Dict:
        """Synthesize and return metadata dict for debugging/api responses.

        Returns:
            {"engine": "kokoro"|"piper", "wav_base64": str, "emotion_style": str,
             "duration_s": float, "sample_rate": int}
            Empty dict on failure.
        """
        if not text or not text.strip():
            return {}

        text = text.strip()
        audio = None
        engine = None

        if force_engine != "piper" and self.kokoro_available:
            audio = self._kokoro.synthesize(text, emotion=emotion)
            if audio is not None:
                engine = "kokoro"

        if audio is None and (force_engine != "kokoro") and self.piper_available:
            logger.info("Kokoro unavailable — falling back to Piper")
            audio = self._synthesize_piper(text)
            if audio is not None:
                engine = "piper"

        if audio is None or len(audio) == 0:
            return {}

        auron = self._auron
        if auron is not None:
            try:
                sr = KOKORO_SAMPLE_RATE if engine == "kokoro" else _PIPER_SAMPLE_RATE
                audio = auron.convert(audio, sr)
                sample_rate = sr
            except Exception as exc:
                logger.error("Auron RVC post-processing failed: %s", exc)
                auron = None

        style = EMOTION_STYLE_MAP.get(emotion or "feliz", {}).get("style", "neutral")
        sample_rate = KOKORO_SAMPLE_RATE if engine == "kokoro" else _PIPER_SAMPLE_RATE
        duration = len(audio) / sample_rate

        return {
            "engine": engine,
            "wav_base64": self._audio_to_wav_base64(audio),
            "emotion_style": style,
            "emotion_tag": emotion or "feliz",
            "duration_s": round(duration, 3),
            "sample_rate": sample_rate,
            "auron_applied": auron is not None,
        }

    def shutdown(self) -> None:
        """Unload Kokoro model to free VRAM."""
        self._kokoro.unload()
        self._kokoro_available = None

    # ------------------------------------------------------------------
    # Piper fallback
    # ------------------------------------------------------------------

    def _synthesize_piper(self, text: str) -> Optional[np.ndarray]:
        """Run piper binary subprocess and capture WAV output.

        Returns float32 numpy array at Piper's native sample rate (22050 Hz).
        """
        try:
            proc = subprocess.run(
                [
                    self._piper_bin,
                    "--model", self._piper_model,
                    "--config", self._piper_config,
                    "--output-raw",
                ],
                input=text.encode("utf-8"),
                capture_output=True,
                timeout=15,
            )
            if proc.returncode != 0:
                logger.error("Piper failed (rc=%d): %s", proc.returncode,
                             proc.stderr.decode(errors="replace")[:200])
                return None

            raw = proc.stdout
            if len(raw) < 4:
                return None

            audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            return audio

        except FileNotFoundError:
            self._piper_available = False
            logger.warning("Piper binary not found at %s", self._piper_bin)
            return None
        except Exception as exc:
            logger.error("Piper synthesis error: %s", exc)
            return None

    def _check_piper(self) -> bool:
        """Check if Piper binary and model exist."""
        bin_ok = Path(self._piper_bin).exists()
        model_ok = Path(self._piper_model).exists()
        if not bin_ok:
            logger.debug("Piper binary missing: %s", self._piper_bin)
        if not model_ok:
            logger.debug("Piper model missing: %s", self._piper_model)
        return bin_ok and model_ok

    # ------------------------------------------------------------------
    # WAV encoding
    # ------------------------------------------------------------------

    @staticmethod
    def _audio_to_wav_base64(audio: np.ndarray) -> str:
        """Convert float32 [-1,1] audio to WAV bytes then base64."""
        samples = np.clip(audio, -1.0, 1.0)
        pcm = (samples * 32767).astype(np.int16)

        buf = io.BytesIO()
        sample_rate = KOKORO_SAMPLE_RATE
        num_channels = 1
        bits_per_sample = 16
        byte_rate = sample_rate * num_channels * bits_per_sample // 8
        block_align = num_channels * bits_per_sample // 8
        data_size = len(pcm) * 2

        buf.write(b"RIFF")
        buf.write(struct.pack("<I", 36 + data_size))
        buf.write(b"WAVE")
        buf.write(b"fmt ")
        buf.write(struct.pack("<I", 16))
        buf.write(struct.pack("<H", 1))            # PCM
        buf.write(struct.pack("<H", num_channels))
        buf.write(struct.pack("<I", sample_rate))
        buf.write(struct.pack("<I", byte_rate))
        buf.write(struct.pack("<H", block_align))
        buf.write(struct.pack("<H", bits_per_sample))
        buf.write(b"data")
        buf.write(struct.pack("<I", data_size))
        buf.write(pcm.tobytes())

        return base64.b64encode(buf.getvalue()).decode("ascii")
