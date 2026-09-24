import enum
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
from openwakeword.model import Model

logger = logging.getLogger(__name__)

# Audio constants
SAMPLE_RATE = 16000
FRAME_SIZE = 1280  # 80ms at 16kHz — OpenWakeWord minimum
PREDICTION_BUFFER_LEN = 30  # OpenWakeWord default

# State machine constants (seconds)
DEFAULT_ACTIVATION_TIMEOUT = 15.0
DEFAULT_COOLDOWN_TIMEOUT = 5.0

# Detection tuning
DEFAULT_THRESHOLD = 0.5
DEFAULT_PATIENCE = 3  # consecutive frames above threshold


class WakeWordState(enum.Enum):
    IDLE = "idle"
    LISTENING = "listening"
    ACTIVATED = "activated"
    COOLDOWN = "cooldown"


@dataclass
class DetectionResult:
    state: WakeWordState
    wake_word: Optional[str] = None
    score: float = 0.0
    previous_state: WakeWordState = WakeWordState.IDLE


class WakeWordDetector:
    """CPU-based wake word detector using OpenWakeWord.

    State machine:
        IDLE → (audio received) → LISTENING → (wake word detected) → ACTIVATED
        ACTIVATED → (timeout) → COOLDOWN → IDLE
        LISTENING → (silence) → IDLE

    Args:
        wake_word: The wake word phrase (e.g., "Uchino")
        model_path: Path to custom ONNX model. If None, uses default pre-trained models.
        threshold: Detection threshold (0-1). Lower = more sensitive.
        patience: Consecutive frames above threshold required for detection.
        activation_timeout: Seconds to stay in ACTIVATED state after wake word.
        cooldown_timeout: Seconds to stay in COOLDOWN before returning to IDLE.
    """

    def __init__(
        self,
        wake_word: str = "Uchino",
        model_path: Optional[str] = None,
        threshold: float = DEFAULT_THRESHOLD,
        patience: int = DEFAULT_PATIENCE,
        activation_timeout: float = DEFAULT_ACTIVATION_TIMEOUT,
        cooldown_timeout: float = DEFAULT_COOLDOWN_TIMEOUT,
    ):
        self.wake_word = wake_word
        self.model_path = model_path
        self.threshold = threshold
        self.patience = patience
        self.activation_timeout = activation_timeout
        self.cooldown_timeout = cooldown_timeout

        self._state = WakeWordState.IDLE
        self._previous_state = WakeWordState.IDLE
        self._state_changed_at = 0.0
        self._activation_end_time = 0.0
        self._cooldown_end_time = 0.0
        self._last_audio_time = 0.0

        # Load OpenWakeWord model
        if model_path:
            logger.info(
                "Loading custom wake word model from %s",
                model_path,
            )
            self._model = Model(wakeword_model_paths=[model_path])
        else:
            # Map display wake words to built-in ONNX models.
            # Only "Hey Jarvis" has a pre-trained model in the default set
            # (alexa, hey_mycroft, hey_jarvis, timer, weather).
            builtin_model_map = {
                "hey_jarvis": "hey_jarvis_v0.1",
                "jarvis": "hey_jarvis_v0.1",
                "uchino": "hey_jarvis_v0.1",
                "oye uchino": "hey_jarvis_v0.1",
                "oye chipi": "hey_jarvis_v0.1",
            }
            normalized = wake_word.strip().lower()
            builtin_key = builtin_model_map.get(normalized)

            if builtin_key:
                import openwakeword
                model_path_builtin = (
                    Path(openwakeword.__file__).parent
                    / "resources" / "models" / f"{builtin_key}.onnx"
                )
                logger.info(
                    "Loading built-in wake word model for '%s' → %s",
                    wake_word,
                    model_path_builtin,
                )
                self._model = Model(wakeword_model_paths=[str(model_path_builtin)])
            else:
                logger.info(
                    "No built-in model for '%s'. Loading all OpenWakeWord "
                    "default models as fallback.",
                    wake_word,
                )
                self._model = Model()

        logger.info(
            "WakeWordDetector initialized: wake_word=%s, threshold=%s, "
            "patience=%d, activation_timeout=%s",
            wake_word,
            threshold,
            patience,
            activation_timeout,
        )

    @property
    def state(self) -> WakeWordState:
        return self._state

    @state.setter
    def state(self, new_state: WakeWordState):
        self._previous_state = self._state
        self._state = new_state
        self._state_changed_at = time.monotonic()
        logger.debug(
            "Wake word state: %s → %s (%.3fs in %s)",
            self._previous_state.value,
            new_state.value,
            time.monotonic() - self._state_changed_at,
            self._previous_state.value,
        )

    def is_activated(self) -> bool:
        return self._state == WakeWordState.ACTIVATED

    def process(self, audio: np.ndarray) -> DetectionResult:
        """Process an audio frame and return the current detection state.

        Args:
            audio: 16-bit PCM mono audio at 16kHz.
                   Should be multiples of FRAME_SIZE (1280 samples / 80ms).

        Returns:
            DetectionResult with current state and optional wake word info.
        """
        now = time.monotonic()

        # Reset model state on state transitions
        if self._state == WakeWordState.COOLDOWN and now >= self._cooldown_end_time:
            self.state = WakeWordState.IDLE

        if self._state == WakeWordState.ACTIVATED and now >= self._activation_end_time:
            self.state = WakeWordState.COOLDOWN
            self._cooldown_end_time = now + self.cooldown_timeout
            return DetectionResult(
                state=self._state,
                previous_state=self._previous_state,
            )

        # Track audio activity for VAD-like purposes
        self._last_audio_time = now

        # In ACTIVATED state, just report state without inferencing
        if self._state == WakeWordState.ACTIVATED:
            return DetectionResult(
                state=WakeWordState.ACTIVATED,
                wake_word=self.wake_word,
                previous_state=self._previous_state,
            )

        # Run wake word inference
        predictions = self._model.predict(
            audio,
            patience={mdl: self.patience for mdl in self._model.models.keys()},
            threshold={mdl: self.threshold for mdl in self._model.models.keys()},
        )

        # Find highest scoring prediction
        max_score = 0.0
        detected_label = None
        for label, score in predictions.items():
            if score > max_score:
                max_score = score
                detected_label = label

        logger.debug(
            "Wake word predictions: %s (max=%.6f, threshold=%s)",
            {k: f"{v:.4f}" for k, v in predictions.items()},
            max_score,
            self.threshold,
        )

        # Check if we should transition to ACTIVATED
        if max_score > 0 and max_score >= self.threshold:
            logger.info(
                "Wake word detected! label=%s score=%.4f threshold=%s",
                detected_label,
                max_score,
                self.threshold,
            )
            self.state = WakeWordState.ACTIVATED
            self._activation_end_time = now + self.activation_timeout
            return DetectionResult(
                state=WakeWordState.ACTIVATED,
                wake_word=self.wake_word,
                score=max_score,
                previous_state=self._previous_state,
            )

        # In listening state but no detection
        if self._state == WakeWordState.IDLE:
            self.state = WakeWordState.LISTENING

        return DetectionResult(
            state=self._state,
            previous_state=self._previous_state,
        )

    def process_bytes(self, audio_bytes: bytes) -> DetectionResult:
        """Process raw PCM16 bytes."""
        audio = np.frombuffer(audio_bytes, dtype=np.int16)
        return self.process(audio)

    def reset(self):
        """Reset detector to IDLE state."""
        self._model.reset()
        self._state = WakeWordState.IDLE
        self._previous_state = WakeWordState.IDLE
        self._activation_end_time = 0.0
        self._cooldown_end_time = 0.0
        logger.debug("Wake word detector reset to IDLE")
