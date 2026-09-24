"""
PLN State Machine — Valid transitions and mappings.

Maps ChipiState (PLN-level) to LangGraph DialogueState (dialogue-level).
The PLN uses its own state machine with clear transition rules,
while the dialogue module uses LangGraph's state graph internally.
"""

from .types import ChipiState

# ── Valid state transitions ─────────────────────────────────
# current_state → list of valid next states
VALID_TRANSITIONS: dict[ChipiState, list[ChipiState]] = {
    ChipiState.SLEEP: [ChipiState.AWAKE],
    ChipiState.AWAKE: [ChipiState.LISTENING, ChipiState.SLEEP],
    ChipiState.LISTENING: [ChipiState.THINKING, ChipiState.SLEEP],
    ChipiState.THINKING: [ChipiState.RESPONDING, ChipiState.LISTENING, ChipiState.SLEEP],
    ChipiState.RESPONDING: [ChipiState.LISTENING, ChipiState.CONFIRMING_ORDER, ChipiState.SLEEP],
    ChipiState.CONFIRMING_ORDER: [ChipiState.DELIVERING, ChipiState.LISTENING, ChipiState.SLEEP],
    ChipiState.DELIVERING: [ChipiState.LISTENING, ChipiState.SLEEP],
}

# ── ChipiState → LangGraph DialogueState ───────────────────
CHIPI_TO_DIALOGUE: dict[ChipiState, str] = {
    ChipiState.SLEEP: "idle",
    ChipiState.AWAKE: "greeting",
    ChipiState.LISTENING: "taking_order",
    ChipiState.THINKING: "confirming_order",
    ChipiState.RESPONDING: "confirming",
    ChipiState.CONFIRMING_ORDER: "confirming_order",
    ChipiState.DELIVERING: "delivering",
}

DIALOGUE_TO_CHIPI: dict[str, ChipiState] = {v: k for k, v in CHIPI_TO_DIALOGUE.items()}


def can_transition(current: ChipiState, next_state: ChipiState) -> bool:
    """Check if a state transition is valid."""
    return next_state in VALID_TRANSITIONS.get(current, [])


def get_default_transition(current: ChipiState) -> ChipiState:
    """Get default next state on timeout — returns SLEEP (safe fallback)."""
    return ChipiState.SLEEP
