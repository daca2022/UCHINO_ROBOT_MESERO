"""
Per-state handler logic for the dialogue state machine.
Each handler receives the current state and user input,
returns updated state with transitions and responses.
"""

from typing import Dict, Any, Optional, List
import time
import os
import re


def _matches_trigger(text: str, triggers: List[str]) -> bool:
    """Match trigger words/phrases against user input with word boundaries.

    Single-word triggers: matched as whole words (e.g., "sí" won't match "así").
    Multi-word triggers: matched as substrings anywhere in the text.
    """
    text_lower = text.lower()
    for trigger in triggers:
        if " " in trigger:
            if trigger in text_lower:
                return True
        else:
            pattern = r'\b' + re.escape(trigger) + r'\b'
            if re.search(pattern, text_lower):
                return True
    return False


FUNCTION_TO_STATE = {
    "registrar_pedido": "taking_order",
    "confirmar_pedido": "confirming_order",
    "cancelar_pedido": "taking_order",
    "ir_a_lugar": "delivering",
    "expresar_emocion": None,      # stays in current state
    "mostrar_menu": None,           # stays in current state
    "guardar_memoria": None,        # stays in current state
    "cargar_preferencias_cliente": None,  # stays in current state
}


STATE_TIMEOUTS = {
    "idle": 300.0,              # 5 min
    "greeting": 120.0,          # 2 min
    "taking_order": 300.0,      # 5 min
    "confirming": 60.0,         # 1 min
    "confirming_order": 120.0,  # 2 min
    "delivering": 600.0,        # 10 min (waiting for delivery)
    "farewell": 30.0,           # 30 sec
}


VALID_TRANSITIONS = {
    "idle": {"greeting", "taking_order"},
    "greeting": {"idle", "taking_order", "farewell"},
    "taking_order": {"idle", "greeting", "confirming", "farewell"},
    "confirming": {"idle", "taking_order", "confirming_order", "farewell"},
    "confirming_order": {"idle", "taking_order", "delivering", "farewell"},
    "delivering": {"idle", "farewell"},
    "farewell": {"idle"},
}


class StateHandler:
    """Base handler with common logic for all states."""

    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")

    def handle(self, state: Dict[str, Any], user_input: str,
               function_calls: Optional[List[Dict]] = None) -> Dict[str, Any]:
        """
        Process user input in the current state.

        Returns updated state dict with:
            - next_state: str
            - response: str
            - order: Optional[Dict]
            - emotion: Optional[str]
            - actions: List[Dict]  # function calls to execute
        """
        current = state.get("current_state", "idle")
        timeout_at = state.get("timeout_at")

        # Check for timeout
        if timeout_at and time.time() > timeout_at:
            return self._timeout_response(state, current)

        # Wake word override: force transition idle→greeting
        if current == "idle" and state.get("wake_word_detected"):
            return self._entry_greeting(state)

        # UI touch override: can jump to any state
        if state.get("ui_touch"):
            ui_target = state.get("ui_target_state")
            if ui_target and ui_target in VALID_TRANSITIONS.get(current, set()):
                return self._transition_to(state, ui_target, "Acción desde panel de control.")

        # Process function calls first (they drive transitions)
        if function_calls:
            return self._process_function_calls(state, current, function_calls)

        # Route to state-specific handler
        handler_method = getattr(self, f"_handle_{current}", None)
        if handler_method:
            return handler_method(state, user_input)
        else:
            return self._handle_idle(state, user_input)

    def _process_function_calls(self, state: Dict, current: str,
                                 function_calls: List[Dict]) -> Dict:
        actions = []
        emotion = state.get("emotion")
        order = state.get("order") or {}

        for fc in function_calls:
            name = fc.get("name", "")
            args = fc.get("args", {})

            if name == "registrar_pedido":
                order = {
                    "mesa": args.get("mesa", order.get("mesa")),
                    "platos": args.get("platos", order.get("platos", [])),
                    "bebida": args.get("bebida", order.get("bebida")),
                    "total": args.get("total", order.get("total", 0)),
                    "estado": "provisional",
                }
                actions.append({"name": "registrar_pedido", "args": args})

            elif name == "confirmar_pedido":
                if order:
                    order["estado"] = "confirmado"
                actions.append({"name": "confirmar_pedido", "args": args})

            elif name == "cancelar_pedido":
                order = {}
                actions.append({"name": "cancelar_pedido", "args": args})

            elif name == "expresar_emocion":
                emotion = args.get("emocion", emotion)
                actions.append({"name": "expresar_emocion", "args": args})

            elif name == "mostrar_menu":
                actions.append({"name": "mostrar_menu", "args": args})

            elif name == "guardar_memoria":
                actions.append({"name": "guardar_memoria", "args": args})

            elif name == "cargar_preferencias_cliente":
                state["customer_name"] = args.get("nombre", state.get("customer_name"))
                state["customer_id"] = args.get("identificador") or args.get("nombre", "")
                if state["customer_id"]:
                    state["customer_id"] = state["customer_id"].lower().replace(" ", "_")
                actions.append({"name": "cargar_preferencias_cliente", "args": args})

            elif name == "ir_a_lugar":
                actions.append({"name": "ir_a_lugar", "args": args})

            target = FUNCTION_TO_STATE.get(name)
            if target and target != current:
                current = target

        state["order"] = order
        state["emotion"] = emotion
        state["actions"] = actions
        state["current_state"] = current
        state["timeout_at"] = time.time() + STATE_TIMEOUTS.get(current, 300)

        return state

    def _handle_idle(self, state: Dict, user_input: str) -> Dict:
        greeting_phrases = [
            "hola", "chipi", "buenos días", "buenas tardes",
            "buenas noches", "mesero", "robot", "oye",
            "qué tal", "oe uchino", "hola uchino", "uchino pe",
            "oyeee", "buenas", "hola pe",
        ]
        if _matches_trigger(user_input, greeting_phrases):
            return self._entry_greeting(state)
        order_triggers = [
            "pedir", "ordenar", "quisiera", "dame", "menú", "menu",
            "carta", "antojo", "provoca", "me das", "me traes",
            "dame nomás", "quiero", "me gustaría", "se me antoja",
            "antoja", "se te antoja",
        ]
        if _matches_trigger(user_input, order_triggers):
            return self._transition_to(state, "taking_order",
                                       "¡Hola! Soy Uchino, tu robot mesero. ¿Qué se te antoja hoy?")
        return self._stay(state, "Estoy en espera. Dime 'Hola Uchino' y te atiendo al toque.")

    def _handle_greeting(self, state: Dict, user_input: str) -> Dict:
        order_words = [
            "pedir", "ordenar", "quisiera", "dame", "quiero", "menú", "menu", "carta",
            "antojo", "provoca", "me das", "me traes", "se me antoja", "dame nomás",
            "antoja", "se te antoja",
        ]
        if _matches_trigger(user_input, order_words):
            return self._transition_to(state, "taking_order",
                                       "¡Claro! Cuéntame qué se te antoja hoy.")
        farewell_words = [
            "adiós", "chau", "gracias", "nada", "bye",
            "nos vemos", "ya fue", "hasta luego", "chau pe", "me voy",
        ]
        if _matches_trigger(user_input, farewell_words):
            return self._transition_to(state, "farewell",
                                        "¡Chau! Que tengas un buen día. ¡Cualquier cosa me llamas!")
        return self._stay(state,
                          "Soy Uchino, tu robot mesero. ¿Quieres ver el menú o pedir algo?")

    def _handle_taking_order(self, state: Dict, user_input: str) -> Dict:
        cancel_words = [
            "cancelar", "cancel", "nada",
            "ya no", "déjalo", "cancelar nomás", "mejor no", "así nomás",
        ]
        if _matches_trigger(user_input, cancel_words):
            return self._transition_to(state, "greeting",
                                        "Entendido, pedido cancelado. ¿Algo más te ofrezco?")
        return self._stay(state, None)

    def _handle_confirming(self, state: Dict, user_input: str) -> Dict:
        confirm_words = [
            "sí", "si", "confirmo", "correcto", "ok", "vale", "bien", "perfecto",
            "dale", "ya", "sí pe", "confirmo nomás", "tal cual", "eso mismo",
            "está bien", "bacán",
        ]
        reject_words = [
            "no", "cancelar", "cancel", "cambiar", "modificar", "equivocado",
            "no pe", "así no", "así no era", "me equivoqué", "no es lo que pedí",
        ]

        if _matches_trigger(user_input, confirm_words):
            return self._transition_to(state, "confirming_order",
                                        "¡Pedido confirmado! Lo envío a cocina al toque.")
        if _matches_trigger(user_input, reject_words):
            return self._transition_to(state, "taking_order",
                                        "Entendido. Dime qué cambios necesitas, con confianza nomás.")
        return self._stay(state, "¿Confirmas el pedido? Responde sí o no.")

    def _handle_confirming_order(self, state: Dict, user_input: str) -> Dict:
        if _matches_trigger(user_input, ["cancelar", "cancel"]):
            if state.get("order", {}).get("estado") == "confirmado":
                return self._transition_to(state, "taking_order",
                                            "Pedido cancelado. ¿Quieres hacer uno nuevo?")
        return self._transition_to(state, "delivering",
                                    "Tu pedido está en camino. Voy a cocina a traerlo, ahorita regreso.")

    def _handle_delivering(self, state: Dict, user_input: str) -> Dict:
        thanks_words = [
            "gracias", "thank", "buen", "bien", "perfecto",
            "chévere", "bacán", "gracias pe", "muy amable",
        ]
        if _matches_trigger(user_input, thanks_words):
            return self._transition_to(state, "farewell",
                                        "¡De nada! Disfruta tu pedido. ¡Chau, cualquier cosa me llamas!")
        return self._stay(state, "Estoy entregando tu pedido. Un momentito porfa.")

    def _handle_farewell(self, state: Dict, user_input: str) -> Dict:
        return self._transition_to(state, "idle", "")

    def _entry_greeting(self, state: Dict) -> Dict:
        return self._transition_to(state, "greeting",
                                    "¡Hola! Soy Uchino, tu robot mesero. ¿En qué te puedo ayudar?")

    def _timeout_response(self, state: Dict, current: str) -> Dict:
        return self._transition_to(state, "idle", "")

    def _transition_to(self, state: Dict, target: str, response: Optional[str]) -> Dict:
        if target not in VALID_TRANSITIONS.get(state.get("current_state", "idle"), set()):
            target = state.get("current_state", "idle")
        next_state = dict(state)
        next_state["current_state"] = target
        next_state["response"] = response or ""
        next_state["actions"] = []
        next_state["function_calls"] = []
        next_state["timeout_at"] = time.time() + STATE_TIMEOUTS.get(target, 300)
        next_state["wake_word_detected"] = False
        next_state["ui_touch"] = False
        return next_state

    def _stay(self, state: Dict, response: Optional[str]) -> Dict:
        next_state = dict(state)
        next_state["response"] = response or ""
        next_state["actions"] = []
        next_state["function_calls"] = []
        return next_state
