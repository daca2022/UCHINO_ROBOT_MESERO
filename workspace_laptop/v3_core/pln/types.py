"""
Foundational types for the PLN (Natural Language Processing) voice pipeline.

Defines ChipiState (enum), OrderItem, DialogueContext, and PLNResponse dataclasses
mapped to the existing LangGraph DialogueState and backend POST /api/pedidos format.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional


class ChipiState(Enum):
    """High-level PLN states mapped to LangGraph DialogueState literals.

    Two states (THINKING and CONFIRMING_ORDER) both map to the same
    dialogue state ``confirming_order`` — they represent different PLN-level
    phases that collapse to a single LangGraph node.
    """

    SLEEP = "sleep"
    AWAKE = "awake"
    LISTENING = "listening"
    THINKING = "thinking"
    RESPONDING = "responding"
    CONFIRMING_ORDER = "confirming_order"
    DELIVERING = "delivering"

    # ── mapping ────────────────────────────────────────────────

    def to_dialogue_state(self) -> str:
        """Return the LangGraph DialogueState literal for this PLN state."""
        mapping: dict[ChipiState, str] = {
            ChipiState.SLEEP: "idle",
            ChipiState.AWAKE: "greeting",
            ChipiState.LISTENING: "taking_order",
            ChipiState.THINKING: "confirming_order",
            ChipiState.RESPONDING: "confirming",
            ChipiState.CONFIRMING_ORDER: "confirming_order",
            ChipiState.DELIVERING: "delivering",
        }
        return mapping[self]

    @classmethod
    def from_dialogue_state(cls, state: str) -> ChipiState:
        """Convert a LangGraph DialogueState literal back to a ChipiState.

        Both ``confirming_order`` and unknown/farewell states default to
        ``THINKING`` and ``SLEEP`` respectively.
        """
        mapping: dict[str, ChipiState] = {
            "idle": cls.SLEEP,
            "greeting": cls.AWAKE,
            "taking_order": cls.LISTENING,
            "confirming_order": cls.THINKING,
            "confirming": cls.RESPONDING,
            "delivering": cls.DELIVERING,
            "farewell": cls.SLEEP,
        }
        return mapping.get(state, cls.SLEEP)


@dataclass
class OrderItem:
    """A single item in a customer's order.

    Attributes:
        nombre:    Item name (must match a menu item).
        cantidad:  Quantity ordered.
        precio:    Unit price.
        categoria: Category (e.g. ``"plato"``, ``"bebida"``, ``"postre"``).
    """

    nombre: str = ""
    cantidad: int = 1
    precio: float = 0.0
    categoria: str = "plato"

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to the format expected by POST /api/pedidos."""
        return {
            "nombre": self.nombre,
            "cantidad": self.cantidad,
            "precio": self.precio,
            "categoria": self.categoria,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> OrderItem:
        """Deserialize from a dict (e.g. from the menu or existing order)."""
        return cls(
            nombre=data.get("nombre", ""),
            cantidad=data.get("cantidad", 1),
            precio=float(data.get("precio", 0.0)),
            categoria=data.get("categoria", "plato"),
        )


@dataclass
class DialogueContext:
    """Mutable context for a single dialogue session.

    Carries the session state, conversation history, active order,
    menu catalogue, client metadata, and vision-derived descriptions.

    The context is meant to be passed through the PLN pipeline stages
    (STT → reasoning → TTS) and mutated in place.
    """

    session_id: str = ""
    state: ChipiState = ChipiState.SLEEP
    history: List[Dict[str, str]] = field(default_factory=list)
    menu_items: List[Dict[str, Any]] = field(default_factory=list)
    client_info: Dict[str, Any] = field(default_factory=dict)
    mesa: Optional[str] = None
    current_order: List[OrderItem] = field(default_factory=list)
    raw_transcription: str = ""
    vision_description: str = ""
    client_id: Optional[str] = None
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    # ── helpers ────────────────────────────────────────────────

    def add_message(self, role: str, content: str) -> None:
        """Append a message to the conversation history."""
        self.history.append({"role": role, "content": content})
        self.updated_at = datetime.now()

    def add_to_order(self, item: OrderItem) -> None:
        """Add or merge an item into the current order.

        If an item with the same ``nombre`` already exists its ``cantidad``
        is incremented (dedup-by-name); otherwise the item is appended.
        """
        for existing in self.current_order:
            if existing.nombre == item.nombre:
                existing.cantidad += item.cantidad
                self.updated_at = datetime.now()
                return
        self.current_order.append(item)
        self.updated_at = datetime.now()

    def clear_order(self) -> None:
        """Remove all items from the current order."""
        self.current_order.clear()
        self.updated_at = datetime.now()

    def get_order_total(self) -> float:
        """Compute the running total of all items in the order."""
        return sum(item.precio * item.cantidad for item in self.current_order)

    def get_order_payload(self, modo: str = "voz") -> Dict[str, Any]:
        """Build the payload dict expected by POST /api/pedidos.

        Args:
            modo: Order mode — ``"voz"`` (voice), ``"pantalla"`` (screen), etc.

        Returns:
            A dict with keys ``mesa``, ``platos``, ``total``, ``modo``.
        """
        return {
            "mesa": self.mesa or "",
            "platos": [item.to_dict() for item in self.current_order],
            "total": self.get_order_total(),
            "modo": modo,
        }


@dataclass
class PLNResponse:
    """Output of the PLN pipeline after processing a transcription.

    Attributes:
        text:                The response text to be spoken by TTS.
        state:               The new PLN state after processing.
        order_items:         Items extracted from the user's utterance.
        audio_data:          Pre-synthesised audio (set by TTS stage).
        is_fast_rule:        ``True`` if this was handled by a fast rule
                             (wake word, emergency bypass) without LLM.
        should_confirm_order:``True`` when the LLM decides the whole order
                             should be read back for confirmation.
        vision_context:      Recent image description from Qwen3 VL 8B.
    """

    text: str = ""
    state: ChipiState = ChipiState.SLEEP
    order_items: List[OrderItem] = field(default_factory=list)
    audio_data: Optional[bytes] = None
    is_fast_rule: bool = False
    should_confirm_order: bool = False
    vision_context: str = ""

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to a JSON-safe dict (excludes binary audio)."""
        return {
            "text": self.text,
            "state": self.state.value,
            "order_items": [item.to_dict() for item in self.order_items],
            "is_fast_rule": self.is_fast_rule,
            "should_confirm_order": self.should_confirm_order,
            "vision_context": self.vision_context,
        }
