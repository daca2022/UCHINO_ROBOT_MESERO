"""
Emotion detection pipeline for Chipi.

Orchestrates:
  1. Speech Emotion Recognition (SER) via `audio_pipeline.ser_branch`
  2. Text sentiment analysis via local transformers model
  3. Fusion of SER + text results into a final Chipi emotion decision.

All local inference via transformers. No cloud APIs.
"""
import json
import logging
from typing import Dict, Optional

import numpy as np

from .emotion_mapper import (
    map_ser_to_chipi,
    map_text_sentiment_to_chipi,
    CHIPI_EMOTIONS,
    EMOTION_META,
)

logger = logging.getLogger(__name__)

# ── Local sentiment model ───────────────────────────────────────────
# cardiffnlp/twitter-xlm-roberta-base-sentiment is multilingual (español included)
# small (280MB), fast on CPU (~30ms), no API key needed
_SENTIMENT_MODEL_NAME = "cardiffnlp/twitter-xlm-roberta-base-sentiment"
_SENTIMENT_PIPELINE = None


def _get_sentiment_pipeline():
    global _SENTIMENT_PIPELINE
    if _SENTIMENT_PIPELINE is None:
        try:
            from transformers import pipeline
            _SENTIMENT_PIPELINE = pipeline(
                "sentiment-analysis",
                model=_SENTIMENT_MODEL_NAME,
                tokenizer=_SENTIMENT_MODEL_NAME,
                top_k=None,
            )
            logger.info(f"[EmotionPipeline] Sentiment model loaded: {_SENTIMENT_MODEL_NAME}")
        except Exception as e:
            logger.error(f"[EmotionPipeline] Failed to load sentiment model: {e}")
    return _SENTIMENT_PIPELINE


_SENTIMENT_LABEL_MAP = {
    "positive": "positivo",
    "negative": "negativo",
    "neutral": "neutro",
}


class EmotionPipeline:
    """
    Combines SER (audio-based) and text sentiment to produce
    a final emotion label for Chipi's `expresar_emocion` function.
    """

    SER_MIN_CONFIDENCE = 0.35
    TEXT_MIN_CONFIDENCE = 0.40
    FUSION_CONFIDENCE_THRESHOLD = 0.45

    def __init__(self):
        self._ser = None
        self._sentiment = None

    # ── SER (audio) ──────────────────────────────────────────────────────

    def _get_ser(self):
        if self._ser is None:
            from v3_core.audio_pipeline.ser_branch import SERBranch

            self._ser = SERBranch()
        return self._ser

    def detect_from_audio(
        self, audio: np.ndarray, sample_rate: int = 16000
    ) -> Optional[Dict]:
        ser = self._get_ser()
        result = ser.process(audio, sample_rate)
        if result is None:
            return None

        ser_label = result["emotion"]
        ser_confidence = result["confidence"]

        chipi_emotion, adjusted_conf = map_ser_to_chipi(ser_label, ser_confidence)

        if chipi_emotion is None or adjusted_conf < self.SER_MIN_CONFIDENCE:
            return None

        return {
            "chipi_emotion": chipi_emotion,
            "confidence": adjusted_conf,
            "source": "ser",
            "ser_label": ser_label,
            "ser_confidence": ser_confidence,
            "scores": result.get("scores", {}),
            "meta": EMOTION_META.get(chipi_emotion, {}),
        }

    # ── Text sentiment (local transformers) ──────────────────────────────

    def _get_sentiment_model(self):
        if self._sentiment is None:
            self._sentiment = _get_sentiment_pipeline()
        return self._sentiment

    def detect_from_text(self, text: str) -> Optional[Dict]:
        text = text.strip()
        if not text or len(text) < 3:
            return None

        pipe = self._get_sentiment_model()
        if pipe is None:
            return None

        try:
            results = pipe(text)
            if results and len(results) > 0:
                top = max(results[0], key=lambda x: x["score"])
                sentiment = _SENTIMENT_LABEL_MAP.get(top["label"], "neutro")
                confidence = top["score"]
            else:
                sentiment = "neutro"
                confidence = 0.5
        except Exception as e:
            logger.warning(f"[EmotionPipeline] Local text sentiment failed: {e}")
            return None

        chipi_emotion, adjusted_conf = map_text_sentiment_to_chipi(sentiment, confidence)

        if adjusted_conf < self.TEXT_MIN_CONFIDENCE:
            return None

        return {
            "chipi_emotion": chipi_emotion,
            "confidence": adjusted_conf,
            "source": "text",
            "raw_sentiment": sentiment,
            "raw_confidence": confidence,
            "meta": EMOTION_META.get(chipi_emotion, {}),
        }

    # ── Fusion ───────────────────────────────────────────────────────────

    def fuse_emotions(
        self,
        ser_result: Optional[Dict],
        text_result: Optional[Dict],
    ) -> Dict:
        """
        Combine SER and text sentiment results into a final emotion decision.

        Strategy:
          1. SER wins if high confidence (>=0.60).
          2. If both available and agree → high confidence.
          3. Text wins if SER is low confidence.
          4. Fallback to 'pensando' if nothing available.
        """
        ser_ok = ser_result is not None
        text_ok = text_result is not None

        if not ser_ok and not text_ok:
            return _fallback_emotion("pensando", "no_input")

        ser_emotion = ser_result["chipi_emotion"] if ser_ok else None
        ser_conf = ser_result["confidence"] if ser_ok else 0.0
        text_emotion = text_result["chipi_emotion"] if text_ok else None
        text_conf = text_result["confidence"] if text_ok else 0.0

        # Rule 1: Strong SER wins outright
        if ser_ok and ser_conf >= 0.60:
            return _make_result(ser_emotion, ser_conf, "ser_strong", ser_result, text_result)

        # Rule 2: Both agree → boost confidence
        if ser_ok and text_ok and ser_emotion == text_emotion:
            fused_conf = min(round((ser_conf + text_conf) / 2 + 0.15, 4), 1.0)
            return _make_result(ser_emotion, fused_conf, "fusion_agree", ser_result, text_result)

        # Rule 3: Only one source available
        if ser_ok and not text_ok:
            if ser_conf >= self.FUSION_CONFIDENCE_THRESHOLD:
                return _make_result(ser_emotion, ser_conf, "ser_only", ser_result, text_result)
            return _fallback_emotion("pensando", "ser_low_confidence")

        if text_ok and not ser_ok:
            if text_conf >= self.FUSION_CONFIDENCE_THRESHOLD:
                return _make_result(text_emotion, text_conf, "text_only", ser_result, text_result)
            return _fallback_emotion("pensando", "text_low_confidence")

        # Rule 4: Both available but disagree → pick higher confidence
        if ser_conf >= text_conf:
            chosen, chosen_conf = ser_emotion, ser_conf
            reason = "ser_disagree_winner"
        else:
            chosen, chosen_conf = text_emotion, text_conf
            reason = "text_disagree_winner"

        if chosen_conf >= self.FUSION_CONFIDENCE_THRESHOLD:
            return _make_result(chosen, chosen_conf, reason, ser_result, text_result)

        return _fallback_emotion("pensando", "fusion_low_confidence")


# ── Helpers ─────────────────────────────────────────────────────────────

def _make_result(
    emotion: str,
    confidence: float,
    reason: str,
    ser_result: Optional[Dict],
    text_result: Optional[Dict],
) -> Dict:
    return {
        "chipi_emotion": emotion,
        "confidence": round(confidence, 4),
        "reason": reason,
        "ser": ser_result,
        "text": text_result,
        "meta": EMOTION_META.get(emotion, {}),
    }


def _fallback_emotion(emotion: str, reason: str) -> Dict:
    return {
        "chipi_emotion": emotion,
        "confidence": 0.1,
        "reason": f"fallback:{reason}",
        "ser": None,
        "text": None,
        "meta": EMOTION_META.get(emotion, {}),
    }


# ── Convenience function ────────────────────────────────────────────────

_pipeline: Optional[EmotionPipeline] = None


def get_pipeline() -> EmotionPipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = EmotionPipeline()
    return _pipeline


def detect_emotion(
    audio: Optional[np.ndarray] = None,
    text: Optional[str] = None,
    sample_rate: int = 16000,
) -> Dict:
    """
    One-shot emotion detection from audio and/or text.

    Args:
        audio: Mono float32 numpy array [-1, 1] (optional).
        text: Transcribed text string (optional).
        sample_rate: Audio sample rate (default 16000).

    Returns:
        Fused emotion dict with chipi_emotion, confidence, reason, meta.
    """
    pipeline = get_pipeline()

    ser_result = None
    text_result = None

    if audio is not None and len(audio) > 0:
        ser_result = pipeline.detect_from_audio(audio, sample_rate)

    if text is not None and text.strip():
        text_result = pipeline.detect_from_text(text)

    return pipeline.fuse_emotions(ser_result, text_result)
