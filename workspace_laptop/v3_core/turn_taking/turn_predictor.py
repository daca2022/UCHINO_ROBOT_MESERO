import logging
import re
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

SENTENCE_FINAL_PUNCTUATION = re.compile(r"[.?!\u2026]$")

CONTINUATION_MARKERS_SPANISH = {
    "pues", "entonces", "y", "pero", "o", "además",
    "también", "porque", "como", "cuando", "donde",
    "aunque", "sin embargo", "no obstante", "es decir",
    "por ejemplo", "en cambio", "mientras", "así que",
    "por eso", "para que", "con", "sin",
}

HESITATION_WORDS_SPANISH = {
    "eh", "este", "mmm", "em", "ah", "uh", "bueno",
    "digo", "o sea", "pues", "entonces", "a ver",
    "cómo te digo", "cómo se dice", "mmm",
}

QUESTION_WORDS_SPANISH = {
    "qué", "cuál", "cómo", "dónde", "cuándo",
    "quién", "por qué", "cuánto", "cuántos",
}

INCOMPLETE_PHRASE_ENDINGS_SPANISH = {
    "un", "una", "el", "la", "los", "las",
    "de", "del", "para", "con", "sin", "por",
    "que", "más", "menos", "mi", "mis",
    "su", "sus", "nuestro", "nuestra",
}

CONFIRMATION_WORDS_SPANISH = {
    "sí", "no", "claro", "gracias", "ok", "vale",
    "perfecto", "listo", "de acuerdo", "eso es todo",
    "nada más", "solo eso",
}


@dataclass
class PauseEvent:
    timestamp: float
    duration_ms: float
    speech_before: str
    speech_after: str
    is_end_of_utterance: bool = False


@dataclass
class PredictionResult:
    customer_finished: bool
    confidence: float
    reason: str
    silence_duration_ms: float
    pause_count: int
    transcript: str


@dataclass
class TurnState:
    transcript_buffer: List[str] = field(default_factory=list)
    pause_history: List[PauseEvent] = field(default_factory=list)
    current_silence_start: Optional[float] = None
    accumulated_silence_ms: float = 0.0
    total_pause_count: int = 0
    last_speech_time: float = 0.0
    is_in_silence: bool = False


class TurnPredictor:
    """
    Rule-based turn-taking predictor for Spanish customer interactions.

    Uses a combination of silence duration, sentence-final punctuation,
    semantic completeness markers, and Spanish-specific pause patterns
    to predict when a speaker has finished their turn.
    """

    def __init__(
        self,
        silence_threshold_ms: float = 700.0,
        long_silence_threshold_ms: float = 1500.0,
        confidence_decay_per_second: float = 0.15,
        max_pause_count: int = 5,
        spanish_mode: bool = True,
    ):
        self.silence_threshold_ms = silence_threshold_ms
        self.long_silence_threshold_ms = long_silence_threshold_ms
        self.confidence_decay_per_second = confidence_decay_per_second
        self.max_pause_count = max_pause_count
        self.spanish_mode = spanish_mode

        self.state = TurnState()
        self._last_prediction: Optional[PredictionResult] = None

    def reset(self):
        self.state = TurnState()
        self._last_prediction = None

    def process_audio_frame(
        self,
        is_speech: bool,
        transcript: str = "",
        sample_time: Optional[float] = None,
    ) -> Optional[PredictionResult]:
        t = sample_time or time.time()

        if is_speech:
            return self._on_speech_start(t, transcript)
        else:
            return self._on_silence(t, transcript)

    def process_silence(
        self,
        duration_ms: float,
        transcript: str = "",
        confidence: float = 1.0,
        silence_count: int = 1,
    ) -> PredictionResult:
        return self._evaluate_turn_completion(
            duration_ms, transcript, confidence, silence_count
        )

    def is_customer_finished(self) -> bool:
        if self._last_prediction:
            return self._last_prediction.customer_finished
        return False

    def predict_turn(
        self,
        latest_transcript: str,
        silence_duration_ms: float,
        silence_count: int,
    ) -> PredictionResult:
        return self._evaluate_turn_completion(
            silence_duration_ms, latest_transcript, 1.0, silence_count
        )

    def _on_speech_start(
        self, t: float, transcript: str
    ) -> Optional[PredictionResult]:
        if self.state.is_in_silence and self.state.current_silence_start:
            pause_duration = (t - self.state.current_silence_start) * 1000.0
            prev_transcript = (
                self.state.transcript_buffer[-1]
                if self.state.transcript_buffer
                else ""
            )
            pause = PauseEvent(
                timestamp=self.state.current_silence_start,
                duration_ms=pause_duration,
                speech_before=prev_transcript,
                speech_after=transcript,
            )
            self.state.pause_history.append(pause)
            self.state.total_pause_count += 1

        self.state.current_silence_start = None
        self.state.is_in_silence = False
        self.state.last_speech_time = t
        self.state.accumulated_silence_ms = 0.0

        if transcript and (
            not self.state.transcript_buffer
            or self.state.transcript_buffer[-1] != transcript
        ):
            self.state.transcript_buffer.append(transcript)

        if len(self.state.transcript_buffer) > 20:
            self.state.transcript_buffer = self.state.transcript_buffer[-10:]

        return None

    def _on_silence(
        self, t: float, transcript: str
    ) -> Optional[PredictionResult]:
        if not self.state.is_in_silence:
            self.state.is_in_silence = True
            self.state.current_silence_start = t

        silence_duration = (
            (t - self.state.current_silence_start) * 1000.0
            if self.state.current_silence_start
            else 0.0
        )

        if transcript and (
            not self.state.transcript_buffer
            or self.state.transcript_buffer[-1] != transcript
        ):
            self.state.transcript_buffer.append(transcript)

        if silence_duration >= self.silence_threshold_ms:
            return self._evaluate_turn_completion(
                silence_duration,
                transcript,
                confidence=1.0,
                silence_count=self.state.total_pause_count + 1,
            )

        return None

    def _evaluate_turn_completion(
        self,
        silence_duration_ms: float,
        transcript: str,
        confidence: float,
        silence_count: int,
    ) -> PredictionResult:
        transcript = (transcript or "").strip().lower()
        signals: List[Tuple[float, str]] = []

        has_final_punct = bool(
            SENTENCE_FINAL_PUNCTUATION.search(transcript)
        )
        if has_final_punct:
            signals.append((0.7, "sentence_final_punctuation"))

        words = transcript.split()
        last_word = words[-1] if words else ""

        is_continuation = last_word in CONTINUATION_MARKERS_SPANISH
        if is_continuation:
            signals.append((-0.5, "continuation_marker"))

        is_hesitation = last_word in HESITATION_WORDS_SPANISH
        if is_hesitation:
            signals.append((-0.4, "hesitation_word"))

        is_question = any(w in QUESTION_WORDS_SPANISH for w in words[-3:])
        if is_question:
            signals.append((-0.3, "question_incomplete"))

        is_incomplete = last_word in INCOMPLETE_PHRASE_ENDINGS_SPANISH
        if is_incomplete:
            signals.append((-0.3, "incomplete_phrase_ending"))

        is_confirmation = any(
            w in CONFIRMATION_WORDS_SPANISH for w in words[-3:]
        )
        if is_confirmation:
            signals.append((0.3, "confirmation_word"))

        if silence_count >= self.max_pause_count:
            signals.append((0.5, "max_pauses_exceeded"))
        elif silence_count >= 3:
            signals.append((0.2, "multiple_pauses"))

        if silence_duration_ms >= self.long_silence_threshold_ms:
            signals.append((0.6, "long_silence"))
        elif silence_duration_ms >= self.silence_threshold_ms * 1.5:
            signals.append((0.3, "moderate_silence"))

        if not transcript:
            signals.append((-0.8, "no_transcript"))
        elif len(words) <= 1:
            signals.append((-0.2, "very_short_utterance"))

        if not signals:
            signals.append((0.0, "no_signals"))

        total_weight = sum(abs(w) for w, _ in signals)
        raw_score = sum(w for w, _ in signals) if total_weight > 0 else 0.0
        normalized_score = max(-1.0, min(1.0, raw_score / max(total_weight, 0.01)))

        base_confidence = (normalized_score + 1.0) / 2.0
        adjusted_confidence = base_confidence * confidence

        if silence_duration_ms >= self.long_silence_threshold_ms:
            adjusted_confidence = max(adjusted_confidence, 0.85)

        customer_finished = adjusted_confidence >= 0.65

        reason_parts = [f"score={normalized_score:.2f}", f"confidence={adjusted_confidence:.2f}"]
        reason_parts.extend(f"{name}({weight:+.1f})" for weight, name in signals)
        reason = " | ".join(reason_parts)

        result = PredictionResult(
            customer_finished=customer_finished,
            confidence=adjusted_confidence,
            reason=reason,
            silence_duration_ms=silence_duration_ms,
            pause_count=silence_count,
            transcript=transcript,
        )

        self._last_prediction = result
        self.state.accumulated_silence_ms = silence_duration_ms

        logger.debug(
            "[TurnTaking] customer_finished=%s conf=%.2f reason=%s",
            customer_finished,
            adjusted_confidence,
            reason,
        )

        return result

    def get_state_summary(self) -> Dict:
        return {
            "customer_finished": self.is_customer_finished(),
            "confidence": (
                self._last_prediction.confidence if self._last_prediction else 0.0
            ),
            "silence_duration_ms": self.state.accumulated_silence_ms,
            "pause_count": self.state.total_pause_count,
            "transcript": (
                self.state.transcript_buffer[-1]
                if self.state.transcript_buffer
                else ""
            ),
            "is_in_silence": self.state.is_in_silence,
        }
