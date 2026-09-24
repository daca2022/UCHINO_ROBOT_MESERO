"""
Tests for emotion module — mapper + pipeline fusion logic.
SER model loading is skipped (heavy); fusion is tested with synthetic results.
"""
import json
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from emotion.emotion_mapper import (
    map_ser_to_chipi,
    map_text_sentiment_to_chipi,
    CHIPI_EMOTIONS,
    EMOTION_META,
)
from emotion.emotion_pipeline import EmotionPipeline


def test_ser_mapping():
    """Test all IEMOCAP label mappings."""
    tests = [
        ("hap", 0.85, "feliz", 0.85),
        ("sad", 0.72, "triste", 0.72),
        ("neu", 0.55, "pensando", 0.55),
        ("ang", 0.63, "sorprendido", 0.63),
        ("fea", 0.50, "triste", 0.375),   # extended, 75% trust
        ("sur", 0.80, "sorprendido", 0.60),  # extended, 75% trust
        ("exc", 0.90, "emocionado", 0.675),  # extended, 75% trust
        ("fru", 0.40, "pensando", 0.30),    # extended
        ("dis", 0.30, "pensando", 0.225),   # extended
        ("oth", 0.20, "pensando", 0.15),    # extended
        ("xxx", 0.90, None, 0.0),           # unknown
        ("", 0.50, None, 0.0),              # empty
    ]
    all_passed = True
    for ser_label, ser_conf, expected_emo, expected_conf in tests:
        emo, conf = map_ser_to_chipi(ser_label, ser_conf)
        ok = emo == expected_emo and abs(conf - expected_conf) < 0.001
        if not ok:
            print(f"  FAIL: map_ser_to_chipi({ser_label!r}, {ser_conf}) → ({emo}, {conf}), expected ({expected_emo}, {expected_conf})")
            all_passed = False
    if all_passed:
        print("  PASS: All SER mappings correct.")
    return all_passed


def test_text_sentiment_mapping():
    """Test text sentiment label mappings."""
    tests = [
        ("positivo", 0.90, "feliz", 0.63),
        ("negativo", 0.80, "triste", 0.56),
        ("neutro", 0.70, "pensando", 0.42),
        # Direct Chipi emotions pass through
        ("feliz", 0.95, "feliz", 0.95),
        ("triste", 0.88, "triste", 0.88),
        ("pensando", 0.65, "pensando", 0.65),
        ("emocionado", 0.99, "emocionado", 0.99),
        ("sorprendido", 0.77, "sorprendido", 0.77),
        ("guiño", 0.55, "guiño", 0.55),
        ("celebrando", 0.92, "celebrando", 0.92),
    ]
    all_passed = True
    for sent, conf, expected_emo, expected_conf in tests:
        emo, adj_conf = map_text_sentiment_to_chipi(sent, conf)
        ok = emo == expected_emo and abs(adj_conf - expected_conf) < 0.001
        if not ok:
            print(f"  FAIL: map_text_sentiment({sent!r}, {conf}) → ({emo}, {adj_conf}), expected ({expected_emo}, {expected_conf})")
            all_passed = False
    if all_passed:
        print("  PASS: All text sentiment mappings correct.")
    return all_passed


def make_ser(emotion, confidence, label="hap"):
    return {
        "chipi_emotion": emotion,
        "confidence": confidence,
        "source": "ser",
        "ser_label": label,
        "ser_confidence": confidence,
        "scores": {label: confidence},
        "meta": EMOTION_META.get(emotion, {}),
    }


def make_text(emotion, confidence, sentiment="positivo"):
    return {
        "chipi_emotion": emotion,
        "confidence": confidence,
        "source": "text",
        "raw_sentiment": sentiment,
        "raw_confidence": confidence,
        "meta": EMOTION_META.get(emotion, {}),
    }


def test_fusion():
    """Test fusion logic with synthetic results (no model loading)."""
    pipeline = EmotionPipeline()  # won't load SER model
    all_passed = True

    cases = [
        # (desc, ser, text, expected_emotion, expected_reason)
        ("SER strong wins", make_ser("feliz", 0.85), make_text("triste", 0.50), "feliz", "ser_strong"),
        ("Both agree → boost", make_ser("feliz", 0.55), make_text("feliz", 0.55), "feliz", "fusion_agree"),
        ("SER only, ok conf", make_ser("triste", 0.50), None, "triste", "ser_only"),
        ("SER only, low conf", make_ser("triste", 0.30), None, "pensando", "fallback:ser_low_confidence"),
        ("Text only, ok conf", None, make_text("feliz", 0.60), "feliz", "text_only"),
        ("Text only, low conf", None, make_text("feliz", 0.30), "pensando", "fallback:text_low_confidence"),
        ("Both disagree, SER higher", make_ser("feliz", 0.55), make_text("triste", 0.48), "feliz", "ser_disagree_winner"),
        ("Both disagree, text higher", make_ser("feliz", 0.40), make_text("triste", 0.50), "triste", "text_disagree_winner"),
        ("Both low → fallback", make_ser("feliz", 0.30), make_text("triste", 0.30), "pensando", "fallback:fusion_low_confidence"),
        ("No input → fallback", None, None, "pensando", "fallback:no_input"),
    ]

    for desc, ser, text, expected_emo, expected_reason in cases:
        result = pipeline.fuse_emotions(ser, text)
        ok = result["chipi_emotion"] == expected_emo and result["reason"].startswith(expected_reason)
        if not ok:
            print(f"  FAIL [{desc}]: got ({result['chipi_emotion']}, {result['reason']}), expected ({expected_emo}, {expected_reason})")
            all_passed = False

    if all_passed:
        print("  PASS: All fusion cases correct.")
    return all_passed


def test_chipi_emotions_set():
    """Verify all 7 Chipi emotions are present."""
    expected = {"feliz", "emocionado", "pensando", "sorprendido", "guiño", "triste", "celebrando"}
    actual = set(CHIPI_EMOTIONS)
    if actual == expected:
        print("  PASS: CHIPI_EMOTIONS set matches expected 7 emotions.")
        return True
    print(f"  FAIL: CHIPI_EMOTIONS = {actual}, expected {expected}")
    return False


def test_emotion_meta():
    """Verify all emotions have metadata."""
    ok = True
    for emo in CHIPI_EMOTIONS:
        if emo not in EMOTION_META:
            print(f"  FAIL: {emo} missing from EMOTION_META")
            ok = False
            continue
        meta = EMOTION_META[emo]
        for key in ("icon", "color", "label_es"):
            if key not in meta:
                print(f"  FAIL: {emo} missing meta key '{key}'")
                ok = False
    if ok:
        print("  PASS: All emotions have complete metadata.")
    return ok


if __name__ == "__main__":
    print("=" * 60)
    print("Emotion Module — Unit Tests")
    print("=" * 60)

    results = {
        "ser_mapping": test_ser_mapping(),
        "text_sentiment": test_text_sentiment_mapping(),
        "fusion": test_fusion(),
        "chipi_set": test_chipi_emotions_set(),
        "emotion_meta": test_emotion_meta(),
    }

    print("-" * 60)
    passed = sum(results.values())
    total = len(results)
    print(f"Results: {passed}/{total} passed")

    if passed == total:
        print("ALL TESTS PASSED")
        sys.exit(0)
    else:
        print("SOME TESTS FAILED")
        sys.exit(1)
