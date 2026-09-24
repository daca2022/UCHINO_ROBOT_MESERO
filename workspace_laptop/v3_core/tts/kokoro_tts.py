"""
Kokoro TTS Wrapper — Offline Spanish speech synthesis with emotional style control.

Uses the Kokoro-82M model (hexgrad/Kokoro-82M) via HuggingFace.
VRAM: ~0.3 GB (well under 2 GB budget).
Voice: ef_dora (only Spanish voice available in Kokoro-82M).
Emotion control: mapped through speed variation (Kokoro has no native emotion tags).

Emotion → Kokoro style mapping (7 Chipi emotions):
    feliz       → cheerful    (speed 1.10)
    emocionado  → excited     (speed 1.22)
    pensando    → calm        (speed 0.90)
    sorprendido → surprised   (speed 1.15)
    guiño       → playful     (speed 1.08)
    triste      → empathetic  (speed 0.84)
    celebrando  → celebrating (speed 1.27)
"""

import logging
import time
import threading
from pathlib import Path
from typing import Optional, Generator, Dict

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Emotion → speed mapping (derived from task spec)
# ---------------------------------------------------------------------------
EMOTION_STYLE_MAP: Dict[str, Dict[str, any]] = {
    "feliz":       {"style": "cheerful",    "speed": 1.10},
    "emocionado":  {"style": "excited",     "speed": 1.22},
    "pensando":    {"style": "calm",        "speed": 0.90},
    "sorprendido": {"style": "surprised",   "speed": 1.15},
    "guiño":       {"style": "playful",     "speed": 1.08},
    "triste":      {"style": "empathetic",  "speed": 0.84},
    "celebrando":  {"style": "celebrating", "speed": 1.27},
}
_DEFAULT_EMOTION = "feliz"
_DEFAULT_SPEED = EMOTION_STYLE_MAP[_DEFAULT_EMOTION]["speed"]

# ---------------------------------------------------------------------------
# Kokoro constants
# ---------------------------------------------------------------------------
KOKORO_REPO_ID = "hexgrad/Kokoro-82M"
KOKORO_LANG_CODE = "e"  # Spanish
KOKORO_VOICE = "ef_dora"  # only Spanish voice in Kokoro-82M
KOKORO_SAMPLE_RATE = 24000
IDLE_UNLOAD_SECONDS = 300.0  # 5 min — sidecar siempre activo, no descargar entre turnos


class KokoroTTS:
    """Lazy-loaded Kokoro TTS engine with emotional style control.

    Loads the model on first use and optionally unloads after idle period
    to keep VRAM footprint minimal (~0.3 GB allocated).

    Usage:
        tts = KokoroTTS()
        tts.ensure_loaded()
        audio = tts.synthesize("¡Hola!", emotion="feliz")
        # audio is numpy float32 array at 24 kHz
    """

    def __init__(
        self,
        repo_id: str = KOKORO_REPO_ID,
        lang_code: str = KOKORO_LANG_CODE,
        voice: str = KOKORO_VOICE,
        idle_unload_s: float = IDLE_UNLOAD_SECONDS,
    ):
        self._repo_id = repo_id
        self._lang_code = lang_code
        self._voice = voice
        self._idle_unload_s = idle_unload_s

        self._pipeline: Optional[any] = None  # kokoro.KPipeline
        self._last_use: float = 0.0
        self._unload_timer: Optional[threading.Timer] = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def loaded(self) -> bool:
        return self._pipeline is not None

    @property
    def sample_rate(self) -> int:
        return KOKORO_SAMPLE_RATE

    @property
    def available_emotions(self) -> list:
        return list(EMOTION_STYLE_MAP.keys())

    def ensure_loaded(self) -> bool:
        """Load model if not already loaded. Returns True on success."""
        if self._pipeline is not None:
            self._touch()
            return True
        with self._lock:
            if self._pipeline is not None:
                self._touch()
                return True
            try:
                self._pipeline = self._load_pipeline()
                self._cancel_timer()
                self._touch()
                logger.info("Kokoro TTS model loaded (repo=%s, lang=%s, voice=%s)",
                            self._repo_id, self._lang_code, self._voice)
                return True
            except Exception as exc:
                logger.error("Failed to load Kokoro TTS model: %s", exc)
                self._pipeline = None
                return False

    def unload(self) -> None:
        """Explicitly unload model to free VRAM."""
        with self._lock:
            if self._pipeline is not None:
                self._pipeline = None
                self._cancel_timer()
                logger.info("Kokoro TTS model unloaded (VRAM freed)")

    def synthesize(
        self,
        text: str,
        emotion: Optional[str] = None,
        speed: Optional[float] = None,
    ) -> Optional[np.ndarray]:
        """Synthesize Spanish speech as float32 numpy array at 24 kHz.

        Args:
            text: Spanish text to synthesize.
            emotion: One of EMOTION_STYLE_MAP keys (default: feliz).
            speed: Override speed (overrides emotion mapping).

        Returns:
            Float32 numpy array or None on failure.
        """
        if not self.ensure_loaded():
            return None

        # Resolve speed
        resolved_speed = self._resolve_speed(emotion, speed)
        style_name = EMOTION_STYLE_MAP.get(emotion or _DEFAULT_EMOTION, {}).get("style", "neutral")

        logger.debug("Synthesizing [%s] speed=%.2f: %r", style_name, resolved_speed, text[:80])

        try:
            gen = self._pipeline(text, voice=self._voice, speed=resolved_speed)
            chunks = list(gen)
            if not chunks:
                logger.warning("Kokoro generated no audio chunks for text: %r", text[:80])
                return None
            audio = np.concatenate([c.audio.cpu().numpy() for c in chunks])
            self._touch()
            self._schedule_unload()
            return audio.astype(np.float32)
        except Exception as exc:
            logger.error("Kokoro synthesis failed: %s", exc)
            return None

    def synthesize_raw(
        self,
        text: str,
        speed: float = _DEFAULT_SPEED,
    ) -> Optional[np.ndarray]:
        """Synthesize with explicit speed (bypasses emotion mapping)."""
        return self.synthesize(text, speed=speed)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_speed(emotion: Optional[str], override: Optional[float]) -> float:
        if override is not None:
            return float(override)
        if emotion and emotion in EMOTION_STYLE_MAP:
            return float(EMOTION_STYLE_MAP[emotion]["speed"])
        return _DEFAULT_SPEED

    def _load_pipeline(self):
        """Import and instantiate kokoro.KPipeline. Done lazily to avoid
        import cost and VRAM allocation until first use."""
        from kokoro import KPipeline          # type: ignore[import-untyped]
        return KPipeline(
            lang_code=self._lang_code,
            repo_id=self._repo_id,
        )

    def _touch(self) -> None:
        self._last_use = time.monotonic()

    def _schedule_unload(self) -> None:
        if self._idle_unload_s <= 0:
            return
        self._cancel_timer()

        def _do_unload():
            elapsed = time.monotonic() - self._last_use
            if elapsed >= self._idle_unload_s:
                self.unload()

        self._unload_timer = threading.Timer(self._idle_unload_s, _do_unload)
        self._unload_timer.daemon = True
        self._unload_timer.start()

    def _cancel_timer(self) -> None:
        if self._unload_timer is not None:
            self._unload_timer.cancel()
            self._unload_timer = None
