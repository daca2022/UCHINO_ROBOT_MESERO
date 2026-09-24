"""
Turn-Taking Prediction Module for Chipi Robot Mesero.

Predicts when a customer has finished speaking so the robot doesn't interrupt.
Uses rule-based heuristics combining Silero VAD silence detection,
transcription completeness, and Spanish-specific pause patterns.

Usage:
    from turn_taking import TurnPredictor

    predictor = TurnPredictor()
    result = predictor.process_silence(
        duration_ms=800,
        transcript="Quisiera un café con leche.",
        silence_count=2,
    )
    if result.get("customer_finished"):
        # Safe to respond now
        ...
"""

from .turn_predictor import TurnPredictor

__all__ = ["TurnPredictor"]
