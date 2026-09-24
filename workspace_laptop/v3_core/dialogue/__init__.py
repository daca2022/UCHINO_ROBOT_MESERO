"""
Chipi Dialogue Module — LangGraph-based state machine for conversation management.

Provides:
    - DialogueGraph: 7-state conversation flow (idle→greeting→taking_order→...)
    - ContextWindowManager: Summarization after 20 turns
    - CheckpointManager: Redis persistence with 1-hour TTL
    - StateHandler: Per-state routing and transition logic

Usage:
    from dialogue import create_dialogue_graph

    graph = create_dialogue_graph()
    result = graph.process_turn(session_id="abc123", user_input="Hola Uchino")
    print(result["current_state"])  # → "greeting"
"""

from .state_machine import DialogueGraph, create_dialogue_graph, DialogueState, DEFAULT_STATE
from .state_handlers import StateHandler, VALID_TRANSITIONS, FUNCTION_TO_STATE, STATE_TIMEOUTS
from .context_manager import ContextWindowManager
from .checkpoint_manager import CheckpointManager

__all__ = [
    "DialogueGraph",
    "create_dialogue_graph",
    "DialogueState",
    "DEFAULT_STATE",
    "StateHandler",
    "VALID_TRANSITIONS",
    "FUNCTION_TO_STATE",
    "STATE_TIMEOUTS",
    "ContextWindowManager",
    "CheckpointManager",
]
