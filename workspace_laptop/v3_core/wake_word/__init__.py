"""
Wake Word Detection Module — Uchino Robot Mesero

Uses OpenWakeWord (dscripka/openWakeWord) for CPU-based wake word detection.
Custom wake word: "Uchino" / "Oye Uchino" (configurable via model path).

Architecture:
    ESP32 PCM16 audio → WakeWordDetector (always running) → if "Uchino" detected
    → activate audio pipeline (DeepFilterNet3 + WhisperLiveKit ASR)

State machine:
    IDLE → (wake word detected) → ACTIVATED → (silence timeout) → IDLE
"""

from .detector import WakeWordDetector, WakeWordState, DetectionResult

__all__ = ["WakeWordDetector", "WakeWordState", "DetectionResult"]
