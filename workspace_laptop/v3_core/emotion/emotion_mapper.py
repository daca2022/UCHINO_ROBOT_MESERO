"""
Maps SER (Speech Emotion Recognition) IEMOCAP labels to Chipi's 7 display emotions.

IEMOCAP labels: neu, ang, hap, sad, fea, sur, dis, fru, exc, oth
Chipi emotions:  feliz, emocionado, pensando, sorprendido, guiño, triste, celebrando

The mapping is intentionally restrictive — only 4 IEMOCAP labels produce confident
Chipi emotions. Others fall through to text-based sentiment classification.
"""

from typing import Dict, Optional, Tuple


# ── Core label mapping ──────────────────────────────────────────────────────
# Only these IEMOCAP labels map directly to a Chipi emotion with confidence.
# Everything else returns None (use text fallback).
SER_TO_CHIPI: Dict[str, str] = {
    "hap": "feliz",       # happy
    "sad": "triste",      # sad
    "neu": "pensando",    # neutral → thinking/concentrating
    "ang": "sorprendido", # angry → surprised (best available match)
}

# Extended IEMOCAP labels that we handle gracefully
EXTENDED_MAP: Dict[str, str] = {
    "fea": "triste",       # fearful → sad (no fear emotion in Chipi)
    "sur": "sorprendido",  # surprised
    "exc": "emocionado",   # excited
    "fru": "pensando",     # frustrated → thinking
    "dis": "pensando",     # disgusted → thinking
    "oth": "pensando",     # other → thinking (neutral fallback)
}


def map_ser_to_chipi(ser_label: str, ser_confidence: float) -> Tuple[Optional[str], float]:
    """
    Map an IEMOCAP emotion label to a Chipi display emotion.

    Args:
        ser_label: Lowercase IEMOCAP label (e.g. 'hap', 'neu', 'ang', 'sad').
        ser_confidence: SER model confidence [0.0, 1.0].

    Returns:
        (chipi_emotion, adjusted_confidence) tuple.
        chipi_emotion is None when the label cannot be mapped confidently.
        adjusted_confidence is capped by a label-specific trust factor.
    """
    ser_label = ser_label.lower().strip()

    chipi_emotion = SER_TO_CHIPI.get(ser_label) or EXTENDED_MAP.get(ser_label)

    if chipi_emotion is None:
        return (None, 0.0)

    # Core labels get full trust; extended labels get 75% trust.
    trust_factor = 1.0 if ser_label in SER_TO_CHIPI else 0.75
    adjusted_confidence = round(ser_confidence * trust_factor, 4)

    return (chipi_emotion, adjusted_confidence)


def map_text_sentiment_to_chipi(sentiment_label: str, confidence: float) -> Tuple[str, float]:
    """
    Map a text-based sentiment label from Gemini to a Chipi emotion.

    Args:
        sentiment_label: Sentiment label from Gemini:
                         'positivo', 'negativo', 'neutro',
                         or a direct Chipi emotion name.
        confidence: Gemini confidence [0.0, 1.0].

    Returns:
        (chipi_emotion, adjusted_confidence).
    """
    label = sentiment_label.lower().strip()

    # Direct Chipi emotions pass through
    if label in CHIPI_EMOTIONS:
        return (label, confidence)

    # Sentiment → emotion mapping
    sentiment_map = {
        "positivo": ("feliz", 0.7),
        "negativo": ("triste", 0.7),
        "neutro": ("pensando", 0.6),
        "positiva": ("feliz", 0.7),
        "negativa": ("triste", 0.7),
    }

    mapped = sentiment_map.get(label)
    if mapped:
        chipi_label, trust = mapped
        return (chipi_label, round(confidence * trust, 4))

    # Unknown label → neutral with low confidence
    return ("pensando", round(confidence * 0.3, 4))


# ── Chipi emotion set ───────────────────────────────────────────────────────
CHIPI_EMOTIONS = frozenset([
    "feliz", "emocionado", "pensando", "sorprendido",
    "guiño", "triste", "celebrando",
])

# ── Display metadata ────────────────────────────────────────────────────────
EMOTION_META: Dict[str, Dict[str, str]] = {
    "feliz":       {"icon": "😊", "color": "#FFD700", "label_es": "Feliz"},
    "emocionado":  {"icon": "🤩", "color": "#FF6B6B", "label_es": "Emocionado"},
    "pensando":    {"icon": "🤔", "color": "#87CEEB", "label_es": "Pensando"},
    "sorprendido": {"icon": "😮", "color": "#FFA500", "label_es": "Sorprendido"},
    "guiño":       {"icon": "😉", "color": "#98FB98", "label_es": "Guiño"},
    "triste":      {"icon": "😢", "color": "#B0C4DE", "label_es": "Triste"},
    "celebrando":  {"icon": "🎉", "color": "#FF69B4", "label_es": "Celebrando"},
}


class EmotionMapper:
    """
    Thin wrapper around the module-level mapping functions.

    Provides a class-based API for consumers that expect an ``EmotionMapper``
    instance (e.g. ``EmotionMapper().map('hap')``).
    """

    def map(self, ser_label: str, ser_confidence: float = 0.8) -> Tuple[Optional[str], float]:
        """Delegate to :func:`map_ser_to_chipi`."""
        return map_ser_to_chipi(ser_label, ser_confidence)

    def map_text(self, sentiment_label: str, confidence: float = 0.8) -> Tuple[str, float]:
        """Delegate to :func:`map_text_sentiment_to_chipi`."""
        return map_text_sentiment_to_chipi(sentiment_label, confidence)
