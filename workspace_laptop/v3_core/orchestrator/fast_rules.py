import time
from typing import Dict, Any, Optional, List

QWEN_FLASH_MODEL = "qwen3.5-flash"
TTFT_THRESHOLD_MS = 2000

ALL_PROVIDERS_DOWN_RESPONSES: Dict[str, str] = {
    "hola": "¡Hola! Soy Uchino. Estoy teniendo dificultades técnicas. ¿Puedes esperar un momento?",
    "gracias": "De nada. Hasta luego.",
}


class FastRuleEngine:
    SAFETY_KEYWORDS = {"alto", "emergencia", "stop", "detente", "cuidado", "peligro"}
    WAKE_WORD_ACK = {"uchino", "oye uchino", "hola uchino", "hey uchino"}
    NAV_CONFIRMATIONS = {"sí", "si", "adelante", "continúa", "continua", "ok", "vale"}
    NAV_CANCELLATIONS = {"no", "cancela", "detente", "espera"}
    BATTERY_LOW_THRESHOLD = 20.0
    OBSTACLE_CLOSE_THRESHOLD_M = 0.5

    def __init__(self, logger=None):
        self.logger = logger or print
        self.last_telemetry = {}
        self.emergency_active = False

    def update_telemetry(self, telemetry: Dict[str, Any]):
        self.last_telemetry = telemetry

    def evaluate(self, input_type: str, data: Any, metadata: Optional[Dict] = None) -> Optional[Dict[str, Any]]:
        metadata = metadata or {}

        if input_type == "text":
            return self._evaluate_text(str(data).lower(), metadata)
        if input_type == "telemetry":
            return self._evaluate_telemetry(data)
        if input_type == "asr_result":
            return self._evaluate_text(str(data.get("transcript", "")).lower(), metadata)
        if input_type == "ttft":
            return self.evaluate_ttft(data)
        if input_type == "function_call":
            return self.evaluate_function_call(data.get("name", ""), data.get("args", {}))
        if input_type == "all_providers_down":
            return self.get_fallback_response(data.get("user_text", ""))
        return None

    def _evaluate_text(self, text: str, metadata: Dict) -> Optional[Dict[str, Any]]:
        words = set(w.lower().strip(".,!?;:()[]{}\"'¿¡") for w in text.split())
        if words & self.SAFETY_KEYWORDS:
            return {
                "action": "immediate",
                "system": "system1",
                "command": "emergency_stop",
                "reason": "safety_keyword",
                "response_text": "¡Deteniéndome de inmediato!",
                "emotion": "sorprendido",
            }

        if any(kw in text for kw in self.WAKE_WORD_ACK) or metadata.get("wake_word_detected"):
            if metadata.get("current_state", "idle") == "idle":
                return {
                    "action": "immediate",
                    "system": "system1",
                    "command": "wake_ack",
                    "reason": "wake_word",
                    "response_text": "¡Hola! Soy Uchino, tu robot mesero. ¿En qué puedo ayudarte?",
                    "emotion": "feliz",
                    "next_state": "greeting",
                }

        if metadata.get("pending_navigation"):
            if any(kw in text for kw in self.NAV_CONFIRMATIONS):
                return {
                    "action": "immediate",
                    "system": "system1",
                    "command": "nav_confirm",
                    "reason": "user_confirmation",
                    "response_text": "De acuerdo, procedo.",
                    "emotion": "neutral",
                }
            if any(kw in text for kw in self.NAV_CANCELLATIONS):
                return {
                    "action": "immediate",
                    "system": "system1",
                    "command": "nav_cancel",
                    "reason": "user_cancellation",
                    "response_text": "Entendido, cancelo la acción.",
                    "emotion": "neutral",
                }

        return None

    def _evaluate_telemetry(self, telemetry: Dict) -> Optional[Dict[str, Any]]:
        battery = telemetry.get("bateria")
        if battery is not None and battery < self.BATTERY_LOW_THRESHOLD:
            if not getattr(self, "_battery_warned", False):
                self._battery_warned = True
                return {
                    "action": "immediate",
                    "system": "system1",
                    "command": "go_to_base",
                    "reason": "low_battery",
                    "response_text": "Batería baja. Regresando a la base para recargar.",
                    "emotion": "triste",
                }
        else:
            self._battery_warned = False

        lidar = telemetry.get("lidar")
        if lidar and lidar.get("distancia", float("inf")) < self.OBSTACLE_CLOSE_THRESHOLD_M:
            return {
                "action": "immediate",
                "system": "system1",
                "command": "stop",
                "reason": "obstacle_detected",
                "response_text": "Detecto un obstáculo cercano. Me detengo.",
                "emotion": "sorprendido",
            }

        return None

    # --- Qwen3.5-Flash specific rules ---

    def evaluate_ttft(self, ttft_ms: float) -> Optional[Dict[str, Any]]:
        """If TTFT exceeds threshold, emit thinking emotion and verbal filler."""
        if ttft_ms > TTFT_THRESHOLD_MS:
            return {
                "action": "immediate",
                "system": "system1",
                "command": "express_emotion",
                "reason": "high_ttft",
                "emotion": "pensando",
                "response_text": "Déjame pensar...",
                "ttft_ms": ttft_ms,
            }
        return None

    def evaluate_function_call(self, name: str, args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Handle function calls from LlmClient format (Qwen tool calls)."""
        if name == "ir_a_lugar":
            destino = args.get("lugar", args.get("destino", "unknown"))
            self.logger(f"[FastRule] Navegación a {destino} registrada (futuro ROS2)")
            return {
                "action": "immediate",
                "system": "system1",
                "command": "navigate",
                "reason": "function_call",
                "function_name": name,
                "destination": destino,
                "response_text": f"De acuerdo, voy hacia {destino}.",
                "emotion": "neutral",
            }

        if name == "expresar_emocion":
            emotion = args.get("emocion", "neutral")
            self.logger(f"[FastRule] Expresando emoción: {emotion}")
            return {
                "action": "immediate",
                "system": "system1",
                "command": "set_emotion",
                "reason": "function_call",
                "function_name": name,
                "emotion": emotion,
                "response_text": None,
            }

        return None

    def get_fallback_response(self, user_text: str) -> Dict[str, Any]:
        """Return hardcoded responses when all providers are down."""
        lower = user_text.lower().strip()

        response_text = ALL_PROVIDERS_DOWN_RESPONSES.get(
            lower,
            "Lo siento, estoy experimentando problemas. Por favor espera un momento.",
        )

        return {
            "action": "fallback",
            "system": "system1",
            "command": "fallback_response",
            "reason": "all_providers_down",
            "response_text": response_text,
            "emotion": "triste",
        }

    def is_safe_transition(self, from_state: str, to_state: str) -> bool:
        unsafe = {
            ("idle", "delivering"),
            ("idle", "confirming_order"),
            ("greeting", "delivering"),
            ("farewell", "delivering"),
        }
        return (from_state, to_state) not in unsafe

    def validate_action(self, action_name: str, args: Dict, current_state: str) -> tuple[bool, Optional[str]]:
        if action_name == "ir_a_lugar" and current_state in {"idle", "farewell"}:
            return False, "No puedo moverme sin un pedido activo."
        if action_name == "actuarBrazo" and args.get("accion") not in {"entregar", "recoger", "reposo"}:
            return False, "Acción de brazo no permitida."
        if action_name == "setVelocity" and abs(args.get("v", 0)) > 1.0:
            return False, "Velocidad excede el límite de seguridad."
        return True, None
