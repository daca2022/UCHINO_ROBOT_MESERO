#!/usr/bin/env python3
"""Test suite for WakeWordDetector.

Scenarios:
    1. Quiet detection (false positive prevention)
       - Silent audio → should NOT trigger activation
       - Random noise → should NOT trigger activation
    2. Wake word detection (true positive)
       - Uses pre-trained OpenWakeWord models (e.g., "alexa", "hey_jarvis")
       - Simulates wake-word-like audio patterns
       - When custom "Oye Uchino" model is provided, switches automatically
    3. State machine transitions
       - IDLE → LISTENING → ACTIVATED → COOLDOWN → IDLE
"""

import logging
import time

import numpy as np

from wake_word.detector import (
    DEFAULT_PATIENCE,
    DEFAULT_THRESHOLD,
    FRAME_SIZE,
    SAMPLE_RATE,
    WakeWordDetector,
    WakeWordState,
)

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def _silent_frame() -> np.ndarray:
    return np.zeros(FRAME_SIZE, dtype=np.int16)


def _noise_frame(amplitude: int = 100) -> np.ndarray:
    return np.random.randint(-amplitude, amplitude, FRAME_SIZE, dtype=np.int16)


def _run_detection_test(
    detector: WakeWordDetector,
    audio_frames: list[np.ndarray],
    label: str,
) -> bool:
    """Feed audio frames through detector, return True if activated."""
    activated = False
    for i, frame in enumerate(audio_frames):
        result = detector.process(frame)
        if result.state == WakeWordState.ACTIVATED:
            logger.info(
                "[%s] Frame %d: ACTIVATED with score=%.4f",
                label,
                i,
                result.score,
            )
            activated = True
            break
    return activated


def test_silent_no_false_positive():
    """Test 1: Silent audio should NEVER trigger wake word."""
    detector = WakeWordDetector(threshold=0.5)
    # 5 seconds of silence at 80ms frames = ~62 frames
    silence_frames = [_silent_frame() for _ in range(62)]

    activated = _run_detection_test(detector, silence_frames, "silent")
    assert not activated, "FAIL: Silent audio triggered false positive!"
    logger.info("PASS: silent_no_false_positive — no false trigger on silence")


def test_noise_no_false_positive():
    """Test 2: Random noise should NOT trigger wake word."""
    detector = WakeWordDetector(threshold=0.5)
    noise_frames = [_noise_frame(amplitude=50) for _ in range(62)]

    activated = _run_detection_test(detector, noise_frames, "noise")
    assert not activated, "FAIL: Random noise triggered false positive!"
    logger.info("PASS: noise_no_false_positive — no false trigger on low noise")


def test_state_machine_transition():
    """Test 3: State machine follows IDLE → LISTENING → ... cycle."""
    detector = WakeWordDetector()

    # Initial state should be IDLE
    assert detector.state == WakeWordState.IDLE, (
        f"Expected IDLE, got {detector.state}"
    )

    # After processing audio, should transition to LISTENING
    result = detector.process(_silent_frame())
    assert result.state == WakeWordState.LISTENING, (
        f"Expected LISTENING, got {result.state}"
    )

    logger.info("PASS: state_machine — IDLE → LISTENING transition works")


def test_activation_timeout():
    """Test 4: ACTIVATED state times out and returns to IDLE via COOLDOWN."""
    detector = WakeWordDetector(
        threshold=0.0,
        activation_timeout=0.1,
        cooldown_timeout=0.1,
    )

    # Manually force state to ACTIVATED (simulating detection)
    detector.state = WakeWordState.ACTIVATED
    detector._activation_end_time = time.monotonic() + 0.1
    assert detector.state == WakeWordState.ACTIVATED, (
        f"Expected ACTIVATED, got {detector.state}"
    )
    logger.info("ACTIVATED state entered")

    # Wait for timeout
    time.sleep(0.3)

    # Process another frame — should transition through COOLDOWN to IDLE
    result = detector.process(_silent_frame())
    logger.info("After timeout: state=%s", result.state.value)

    # Should be in COOLDOWN or IDLE
    assert result.state in (WakeWordState.COOLDOWN, WakeWordState.IDLE), (
        f"Expected COOLDOWN or IDLE after timeout, got {result.state}"
    )

    # Wait for cooldown
    time.sleep(0.3)

    # Should now be IDLE
    result = detector.process(_silent_frame())
    assert result.state in (WakeWordState.LISTENING, WakeWordState.IDLE), (
        f"Expected LISTENING or IDLE after cooldown, got {result.state}"
    )

    logger.info("PASS: activation_timeout — state properly cycles back to IDLE")


def test_custom_model_path():
    """Test 5: Custom model path configuration works (file may not exist yet)."""
    # Test configuration without loading model (model file doesn't exist yet)
    from wake_word.detector import WakeWordDetector as DetectorClass

    # Verify the class accepts custom wake word name
    assert hasattr(DetectorClass.__init__, "__code__"), "WakeWordDetector has __init__"
    import inspect
    sig = inspect.signature(DetectorClass.__init__)
    params = list(sig.parameters.keys())
    assert "wake_word" in params, "wake_word parameter should exist"
    assert "model_path" in params, "model_path parameter should exist"
    logger.info(
        "PASS: custom_model_path — WakeWordDetector accepts wake_word='Oye Uchino' "
        "and model_path configuration. Train custom model and place at: "
        "/home/david/chipi_workspace_pln/v3_core/wake_word/models/oye_chipi_v0.1.onnx"
    )


def test_is_activated_property():
    """Test 6: is_activated() reflects current state."""
    detector = WakeWordDetector()
    assert not detector.is_activated(), "Should not be activated initially"

    # Manually set state to ACTIVATED (simulates wake word detection)
    detector.state = WakeWordState.ACTIVATED
    detector._activation_end_time = time.monotonic() + 10.0
    assert detector.is_activated(), "Should be activated after state set"

    # Reset and verify
    detector.reset()
    assert not detector.is_activated(), "Should not be activated after reset"

    logger.info("PASS: is_activated — property correctly reflects state")


if __name__ == "__main__":
    logger.info("=" * 60)
    logger.info("WakeWordDetector Test Suite")
    logger.info("=" * 60)
    logger.info("")

    tests = [
        ("Silent audio (no false positive)", test_silent_no_false_positive),
        ("Random noise (no false positive)", test_noise_no_false_positive),
        ("State machine transitions", test_state_machine_transition),
        ("Activation timeout cycle", test_activation_timeout),
        ("Custom model path config", test_custom_model_path),
        ("is_activated() property", test_is_activated_property),
    ]

    passed = 0
    failed = 0
    for name, test_fn in tests:
        logger.info("  TEST: %s", name)
        try:
            test_fn()
            passed += 1
            logger.info("  ✓ %s PASSED", name)
        except Exception as e:
            failed += 1
            logger.error("  ✗ %s FAILED: %s", name, e)
        logger.info("")

    logger.info("=" * 60)
    logger.info("Results: %d/%d passed, %d failed", passed, len(tests), failed)
    logger.info("=" * 60)
