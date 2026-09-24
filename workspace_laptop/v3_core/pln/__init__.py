"""
PLN (Natural Language Processing) voice pipeline module for Uchino Robot.

Central types and the main orchestrator placeholder for the voice
pipeline that routes audio through STT → reasoning → TTS → response.
"""

from .types import ChipiState, OrderItem, DialogueContext, PLNResponse
from .order_extractor import OrderExtractor


class ChipiPLN:
    """Placeholder for the main PLN orchestrator.

    Will coordinate the full voice pipeline:
        1. Receive transcription from WhisperLiveKit
        2. Decide fast-rule vs. full LLM reasoning
        3. Invoke DeepSeek / Qwen3 VL / memory / LangGraph dialogue
        4. Produce a ``PLNResponse`` with TTS audio
    """

    pass


__all__ = [
    "ChipiPLN",
    "ChipiState",
    "OrderItem",
    "DialogueContext",
    "PLNResponse",
    "OrderExtractor",
]
