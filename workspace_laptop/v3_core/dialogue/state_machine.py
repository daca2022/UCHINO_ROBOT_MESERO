"""
LangGraph State Machine for Uchino Dialogue — 7-state conversation flow.

States: idle → greeting → taking_order → confirming → confirming_order → delivering → farewell

Each transition is triggered by: intent recognition and tool calling,
wake word detection, UI touch input, or timeout.
"""

from typing import TypedDict, List, Dict, Optional, Any, Annotated, Literal
import operator
import os
import uuid
import time
import json
import asyncio
import concurrent.futures

from langgraph.graph import StateGraph, START, END

from .context_manager import ContextWindowManager
from .checkpoint_manager import CheckpointManager
from .state_handlers import StateHandler, VALID_TRANSITIONS, FUNCTION_TO_STATE
from .llm_client import LlmClient

try:
    from ..memory.person_memory import PersonMemory, create_user_id
    HAS_PERSON_MEMORY = True
except ImportError:
    HAS_PERSON_MEMORY = False


DIALOGUE_STATES = Literal[
    "idle", "greeting", "taking_order",
    "confirming", "confirming_order", "delivering", "farewell"
]

state_prompts = {
    "idle": "Espera una llamada del cliente.",
    "greeting": "Saluda una sola vez y ofrece ayuda.",
    "taking_order": "Toma el pedido como borrador hasta la confirmación.",
    "confirming": "Resume el pedido y solicita confirmación explícita.",
    "confirming_order": "Verifica la confirmación antes de enviar a cocina.",
    "delivering": "Comunica el destino y prioriza la seguridad.",
    "farewell": "Cierra la interacción de forma breve.",
}


class DialogueState(TypedDict):
    session_id: str
    current_state: DIALOGUE_STATES
    messages: Annotated[List[Dict[str, str]], operator.add]
    turn_count: int
    summary: Optional[str]
    order: Optional[Dict[str, Any]]
    user_input: str
    response: str
    function_calls: List[Dict[str, Any]]
    actions: List[Dict[str, Any]]
    timeout_at: float
    wake_word_detected: bool
    ui_touch: bool
    ui_target_state: Optional[str]
    emotion: Optional[str]
    customer_id: Optional[str]
    customer_name: Optional[str]
    customer_preferences: Optional[Dict[str, Any]]
    customer_finished: bool


DEFAULT_STATE: DialogueState = {
    "session_id": "",
    "current_state": "idle",
    "messages": [],
    "turn_count": 0,
    "summary": None,
    "order": None,
    "user_input": "",
    "response": "",
    "function_calls": [],
    "actions": [],
    "timeout_at": 0.0,
    "wake_word_detected": False,
    "ui_touch": False,
    "ui_target_state": None,
    "emotion": None,
    "customer_id": None,
    "customer_name": None,
    "customer_preferences": None,
    "customer_finished": False,
}


class DialogueGraph:
    """
    LangGraph-based state machine for Chipi's conversation flow.

    Features:
        - 7 states with valid transitions
        - LLM tool-calling integration
        - Redis checkpointing (1 hour TTL)
        - Context window management (summarize after 20 turns)
        - Multi-session resume
    """

    def __init__(self, api_key: Optional[str] = None,
                 redis_host: str = "localhost", redis_port: int = 6379,
                 checkpoint_ttl: int = 3600, gemini_model: str = "gemini-2.0-flash",
                 use_gemini: bool = False):

        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        self.gemini_model_name = gemini_model
        self.use_gemini = use_gemini

        # Init sub-modules
        self.checkpoint = CheckpointManager(
            host=redis_host, port=redis_port, ttl=checkpoint_ttl
        )
        self.context = ContextWindowManager(
            api_key=self.api_key, model=gemini_model
        )
        self.handler = StateHandler(api_key=self.api_key)

        self.person_memory = None
        legacy_memory_enabled = os.getenv("LEGACY_UNSCOPED_MEMORY_ENABLED", "").lower() in {"1", "true", "yes"}
        if HAS_PERSON_MEMORY and legacy_memory_enabled:
            try:
                self.person_memory = PersonMemory()
            except Exception:
                pass

        self._llm_client = LlmClient()

        # Build LangGraph
        self.graph = self._build_graph()

    def _build_graph(self) -> StateGraph:
        builder = StateGraph(DialogueState)

        # Add all 7 state nodes
        builder.add_node("idle", self._node_idle)
        builder.add_node("greeting", self._node_greeting)
        builder.add_node("taking_order", self._node_taking_order)
        builder.add_node("confirming", self._node_confirming)
        builder.add_node("confirming_order", self._node_confirming_order)
        builder.add_node("delivering", self._node_delivering)
        builder.add_node("farewell", self._node_farewell)

        # Start routing: determine entry state
        builder.add_conditional_edges(START, self._route_entry, {
            "idle": "idle",
            "greeting": "greeting",
            "taking_order": "taking_order",
            "confirming": "confirming",
            "confirming_order": "confirming_order",
            "delivering": "delivering",
            "farewell": "farewell",
        })

        # Each state routes to END after processing (one turn = one invoke)
        builder.add_edge("idle", END)
        builder.add_edge("greeting", END)
        builder.add_edge("taking_order", END)
        builder.add_edge("confirming", END)
        builder.add_edge("confirming_order", END)
        builder.add_edge("delivering", END)
        builder.add_edge("farewell", END)

        compiled = builder.compile()
        return compiled

    def _all_states_map(self) -> Dict[str, str]:
        return {s: s for s in ["idle", "greeting", "taking_order",
                               "confirming", "confirming_order",
                               "delivering", "farewell", END]}

    def _route_entry(self, state: DialogueState) -> str:
        return state.get("current_state", "idle")

    def _route_idle(self, state: DialogueState) -> str:
        return state.get("current_state", "idle")

    def _route_greeting(self, state: DialogueState) -> str:
        return state.get("current_state", "greeting")

    def _route_taking_order(self, state: DialogueState) -> str:
        return state.get("current_state", "taking_order")

    def _route_confirming(self, state: DialogueState) -> str:
        return state.get("current_state", "confirming")

    def _route_confirming_order(self, state: DialogueState) -> str:
        return state.get("current_state", "confirming_order")

    def _route_delivering(self, state: DialogueState) -> str:
        return state.get("current_state", "delivering")

    def _route_farewell(self, state: DialogueState) -> str:
        return state.get("current_state", "farewell")

    def _load_customer_context(self, state: DialogueState) -> DialogueState:
        """Try to identify customer from name mentions and load their preferences."""
        if not self.person_memory or not HAS_PERSON_MEMORY:
            return state

        user_input = state.get("user_input", "")
        if not user_input:
            return state

        customer_name = state.get("customer_name")
        customer_id = state.get("customer_id")

        if not customer_id and not customer_name:
            name_keywords = [
                "me llamo", "soy ", "mi nombre es", "yo soy",
                "nombre es", "llamo ",
            ]
            lower = user_input.lower()
            for kw in name_keywords:
                if kw in lower:
                    after = lower.split(kw, 1)[1].strip().split()[0] if lower.split(kw, 1)[1].strip() else ""
                    if after and len(after) > 1 and after.isalpha():
                        customer_name = after.capitalize()
                        customer_id = create_user_id(name=customer_name)
                        break

        if not customer_id and customer_name:
            customer_id = create_user_id(name=customer_name)

        if not customer_id:
            return state

        if not state.get("customer_preferences"):
            profile = self.person_memory.extract_profile(customer_id)
            preferences = self.person_memory.get_preferences(customer_id)
            allergies = self.person_memory.get_allergies(customer_id)

            state["customer_id"] = customer_id
            state["customer_name"] = profile.get("nombre") or customer_name
            state["customer_preferences"] = {
                "profile": profile,
                "preferences": preferences,
                "allergies": allergies,
            }

        return state

    def _apply_handler(self, state: DialogueState) -> DialogueState:
        state = self._load_customer_context(state)

        if not state.get("customer_finished", True) and not state.get("ui_touch") and not state.get("wake_word_detected"):
            new_state = dict(state)
            new_state["response"] = ""
            new_state["actions"] = []
            new_state["function_calls"] = []
            new_state["wake_word_detected"] = False
            new_state["ui_touch"] = False
            return new_state

        user_input = state.get("user_input", "")
        function_calls = state.get("function_calls") or []

        prior_actions = list(state.get("actions") or [])

        if user_input:
            function_calls = self._detect_intent(state) or function_calls

        state_for_handler = dict(state)
        state_for_handler["actions"] = []
        state_for_handler["function_calls"] = []

        result = self.handler.handle(
            state_for_handler, user_input, function_calls
        )

        new_state = dict(state)
        new_state["current_state"] = result.get("current_state", state.get("current_state"))
        new_state["response"] = result.get("response", "")
        new_state["order"] = result.get("order", state.get("order"))
        new_state["emotion"] = result.get("emotion", state.get("emotion"))
        new_state["actions"] = result.get("actions") if result.get("actions") is not None else []
        new_state["timeout_at"] = result.get("timeout_at", state.get("timeout_at"))
        new_state["wake_word_detected"] = False
        new_state["ui_touch"] = False
        new_state["function_calls"] = []
        new_state["customer_finished"] = False
        new_state["customer_name"] = result.get("customer_name", state.get("customer_name"))
        new_state["customer_id"] = result.get("customer_id", state.get("customer_id"))
        new_state["customer_preferences"] = result.get("customer_preferences", state.get("customer_preferences"))

        if user_input:
            new_state["messages"] = state.get("messages", []) + [
                {"role": "user", "content": user_input}
            ]
        if new_state.get("response"):
            new_state["messages"] = new_state["messages"] + [
                {"role": "assistant", "content": new_state["response"]}
            ]

        new_state["turn_count"] = state.get("turn_count", 0) + 1

        managed_messages, summary = self.context.manage(
            new_state["messages"], state.get("summary")
        )
        new_state["messages"] = managed_messages
        new_state["summary"] = summary

        return new_state

    def _get_tools_declaration(self):
        """Return function declarations matching GeminiAdapter's tools."""
        return [{
            "function_declarations": [
                {
                    "name": "registrar_pedido",
                    "description": "Registra el pedido provisional del cliente.",
                    "parameters": {
                        "type": "OBJECT",
                        "properties": {
                            "mesa": {"type": "STRING"},
                            "platos": {"type": "ARRAY", "items": {
                                "type": "OBJECT", "properties": {
                                    "nombre": {"type": "STRING"},
                                    "cantidad": {"type": "INTEGER"},
                                    "precio": {"type": "NUMBER"},
                                }
                            }},
                            "bebida": {"type": "STRING"},
                            "total": {"type": "NUMBER"},
                        },
                        "required": ["platos"],
                    },
                },
                {"name": "confirmar_pedido", "description": "Confirma y envía el pedido a cocina.",
                 "parameters": {"type": "OBJECT", "properties": {}}},
                {"name": "cancelar_pedido", "description": "Cancela el pedido actual.",
                 "parameters": {"type": "OBJECT", "properties": {}}},
                {"name": "ir_a_lugar", "description": "Mueve el robot a un lugar específico.",
                 "parameters": {"type": "OBJECT", "properties": {
                     "lugar": {"type": "STRING", "enum": ["MESA", "COCINA", "UTENSILIOS", "BEBIDAS", "CAJA", "BASE"]}
                 }, "required": ["lugar"]}},
                {"name": "expresar_emocion", "description": "Cambia la expresión del robot en la pantalla.",
                 "parameters": {"type": "OBJECT", "properties": {
                     "emocion": {"type": "STRING", "enum": ["feliz", "emocionado", "pensando", "sorprendido", "guiño", "triste", "celebrando"]},
                     "mensaje": {"type": "STRING"},
                 }, "required": ["emocion"]}},
                {"name": "mostrar_menu", "description": "Muestra el menú del día.",
                 "parameters": {"type": "OBJECT", "properties": {
                     "etapa": {"type": "STRING", "enum": ["platos", "bebidas", "completo"]}
                 }}},
                {"name": "guardar_memoria", "description": "Guarda información a largo plazo.",
                 "parameters": {"type": "OBJECT", "properties": {
                     "categoria": {"type": "STRING", "enum": ["cliente", "preferencia", "hecho", "configuracion"]},
                     "clave": {"type": "STRING"},
                     "valor": {"type": "STRING"},
                 }, "required": ["categoria", "clave", "valor"]}},
                {"name": "cargar_preferencias_cliente", "description": "Carga las preferencias, alergias y perfil de un cliente identificado. Usar cuando el cliente dice su nombre o es reconocido.",
                 "parameters": {"type": "OBJECT", "properties": {
                     "nombre": {"type": "STRING"},
                     "identificador": {"type": "STRING"},
                 }}},
            ]
        }]

    def _detect_intent(self, state: DialogueState) -> List[Dict]:
        """Use LLM bridge to detect intent and trigger function calls."""
        try:
            user_input = state.get("user_input", "")
            if not user_input:
                return []

            current_state = state.get("current_state", "idle")
            session_id = state.get("session_id", "")
            mesa = state.get("mesa") or state.get("order", {}).get("mesa")
            customer_id = state.get("customer_id") or session_id

            import os as _os
            import sys as _sys
            if _os.environ.get("UCHINO_DIALOGUE_DEBUG") == "1":
                _sys.stderr.write(f"[DBG-DETECT] session={session_id} state_mesa={mesa!r} input={user_input[:50]!r}\n")
                _sys.stderr.flush()

            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    response = None
                    import concurrent.futures
                    def _runner():
                        new_loop = asyncio.new_event_loop()
                        try:
                            return new_loop.run_until_complete(
                                self._llm_client.send_dialogue(
                                    state=current_state,
                                    input_text=user_input,
                                    session_id=session_id,
                                    mesa=mesa,
                                    client_id=customer_id,
                                )
                            )
                        finally:
                            new_loop.close()
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                        future = executor.submit(_runner)
                        response = future.result(timeout=30)
                else:
                    response = loop.run_until_complete(
                        self._llm_client.send_dialogue(
                            state=current_state,
                            input_text=user_input,
                            session_id=session_id,
                            mesa=mesa,
                            client_id=customer_id,
                        )
                    )
            except RuntimeError:
                import concurrent.futures
                def _runner():
                    new_loop = asyncio.new_event_loop()
                    try:
                        return new_loop.run_until_complete(
                            self._llm_client.send_dialogue(
                                state=current_state,
                                input_text=user_input,
                                session_id=session_id,
                                mesa=mesa,
                                client_id=customer_id,
                            )
                        )
                    finally:
                        new_loop.close()
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(_runner)
                    response = future.result(timeout=30)

            if response is None or not isinstance(response, dict):
                return []
            fcs = response.get("functionCalls", [])
            if _os.environ.get("UCHINO_DIALOGUE_DEBUG") == "1":
                _sys.stderr.write(f"[DBG-DETECT] session={session_id} fcs={fcs}\n")
                _sys.stderr.flush()
            return fcs

        except Exception:
            return []

    def _system_prompt(self, state: DialogueState) -> str:
        current_state = state.get("current_state", "idle")
        summary = state.get("summary", "")
        order = state.get("order", {})

        summary_block = ""
        if summary:
            summary_block = f"\n[Resumen de conversación anterior]\n{summary}\n[/Resumen]"

        order_block = ""
        if order and order.get("platos"):
            plates = order.get("platos", [])
            plate_desc = ", ".join(
                f"{p.get('nombre', '?')} x{p.get('cantidad', 1)}"
                for p in plates
            )
            order_block = f"\n[Pedido actual]\nPlatos: {plate_desc}\nBebida: {order.get('bebida', 'N/A')}\nTotal: ${order.get('total', 0)}\nEstado: {order.get('estado', 'provisional')}\n[/Pedido]"

        cust_block = ""
        cust_prefs = state.get("customer_preferences")
        if cust_prefs:
            profile = cust_prefs.get("profile", {})
            nombre = profile.get("nombre") or state.get("customer_name", "")
            prefs = cust_prefs.get("preferences", [])
            allergies = cust_prefs.get("allergies", [])
            favs = profile.get("pedidos_favoritos", [])
            parts = []
            if nombre:
                parts.append(f"Cliente: {nombre}")
            if prefs:
                parts.append(f"Preferencias: {', '.join(prefs)}")
            if allergies:
                parts.append(f"Alergias: {', '.join(allergies)}")
            if favs:
                parts.append(f"Pedidos favoritos: {', '.join(favs)}")
            if parts:
                cust_block = "\n[Perfil del cliente]\n" + "\n".join(parts) + "\n[/Perfil]"

        return (
            f"Eres Uchino, un robot mesero del restaurante UTEC. Eres amable, servicial y eficiente.\n"
            f"Estado actual: {current_state}\n"
            f"{state_prompts.get(current_state, '')}\n"
            f"{summary_block}\n"
            f"{order_block}\n"
            f"{cust_block}\n"
            f"Responde en español, con frases cortas y claras. "
            f"Usa las funciones disponibles cuando sea apropiado."
        )

    def _node_idle(self, state: DialogueState) -> DialogueState:
        return self._apply_handler(state)

    def _node_greeting(self, state: DialogueState) -> DialogueState:
        return self._apply_handler(state)

    def _node_taking_order(self, state: DialogueState) -> DialogueState:
        return self._apply_handler(state)

    def _node_confirming(self, state: DialogueState) -> DialogueState:
        return self._apply_handler(state)

    def _node_confirming_order(self, state: DialogueState) -> DialogueState:
        return self._apply_handler(state)

    def _node_delivering(self, state: DialogueState) -> DialogueState:
        return self._apply_handler(state)

    def _node_farewell(self, state: DialogueState) -> DialogueState:
        return self._apply_handler(state)

    # ── Public API ──────────────────────────────────────────────

    def process_turn(self, session_id: str, user_input: str,
                     wake_word: bool = False, ui_touch: bool = False,
                     ui_target_state: Optional[str] = None,
                     customer_finished: bool = False,
                     mesa: Optional[str] = None,
                     customer_id: Optional[str] = None) -> Dict[str, Any]:
        """Process a single conversation turn."""
        saved = self.checkpoint.load_manual(session_id)
        if saved:
            state_input = {
                **DEFAULT_STATE,
                "session_id": session_id,
                "current_state": saved.get("current_state", "idle"),
                "messages": saved.get("messages", []),
                "turn_count": saved.get("turn_count", 0),
                "summary": saved.get("summary"),
                "order": saved.get("order"),
                "timeout_at": saved.get("timeout_at", 0.0),
                "emotion": saved.get("emotion"),
                "mesa": saved.get("mesa"),
                "customer_id": saved.get("customer_id"),
            }
        else:
            state_input = {
                **DEFAULT_STATE,
                "session_id": session_id,
            }

        state_input["user_input"] = user_input
        state_input["wake_word_detected"] = wake_word
        state_input["ui_touch"] = ui_touch
        state_input["ui_target_state"] = ui_target_state
        state_input["customer_finished"] = customer_finished
        if mesa is not None:
            state_input["mesa"] = mesa
        if customer_id is not None:
            state_input["customer_id"] = customer_id

        config = {"configurable": {"thread_id": session_id}}

        result = self.graph.invoke(state_input, config)

        persisted_mesa = mesa if mesa is not None else state_input.get("mesa")
        persisted_cid = customer_id if customer_id is not None else state_input.get("customer_id")
        self.checkpoint.save_manual(session_id, {
            "current_state": result.get("current_state", "idle"),
            "messages": result.get("messages", []),
            "turn_count": result.get("turn_count", 0),
            "summary": result.get("summary"),
            "order": result.get("order"),
            "timeout_at": result.get("timeout_at", 0.0),
            "emotion": result.get("emotion"),
            "mesa": persisted_mesa,
            "customer_id": persisted_cid,
        })

        return {
            "session_id": session_id,
            "current_state": result.get("current_state", "idle"),
            "response": result.get("response", ""),
            "order": result.get("order"),
            "emotion": result.get("emotion"),
            "actions": result.get("actions", []),
            "customer_finished": result.get("customer_finished", False),
        }

    def resume_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        return self.checkpoint.load_manual(session_id)

    def end_session(self, session_id: str) -> None:
        self.checkpoint.delete_session(session_id)

    def get_active_sessions(self) -> list:
        return self.checkpoint.list_active_sessions()

    def health_check(self) -> Dict[str, bool]:
        return {
            "redis": self.checkpoint.health_check(),
            "llm_bridge": True,
        }


def create_dialogue_graph(api_key: Optional[str] = None,
                          redis_host: str = "localhost",
                          redis_port: int = 6379,
                          checkpoint_ttl: int = 3600,
                          use_gemini: bool = False,
                          gemini_model: str = "gemini-2.0-flash") -> DialogueGraph:
    api_key = api_key or os.getenv("OPENROUTER_API_KEY")
    redis_host = redis_host or os.getenv("REDIS_HOST", "localhost")
    redis_port = int(redis_port or os.getenv("REDIS_PORT", "6379"))
    return DialogueGraph(
        api_key=api_key,
        redis_host=redis_host,
        redis_port=redis_port,
        checkpoint_ttl=checkpoint_ttl,
        use_gemini=use_gemini,
        gemini_model=gemini_model,
    )
