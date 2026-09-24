"""
execution_checker.py — Post-action visual verification for Chipi robot.

RoboMatrix pattern: verify each critical action's result before proceeding
to the next step in the task chain. Only important actions (navigation,
delivery, manipulation) are verified — max 1 extra API call per action.

Socratica pattern: on verification failure, trigger Gemini-driven
re-planning to find an alternative corrective action.

SYNAPSE/BrainMem pattern: log all verification results to memory for
future rule extraction and learning.

Dependencies:
    T8 (vision_manager.mjs / VisionClient) — frame capture + OpenRouter vision query
    T13 (master_orchestrator.py) — dual-brain action orchestration
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List, Optional

# ── Constants ──────────────────────────────────────────────────────────────────

# Only verify actions that materially change robot state (RoboMatrix:
# verify at key decision points, not every micro-step).
VERIFIABLE_ACTIONS: set[str] = {
    "ir_a_lugar",
    "entregar_pedido",
    "recoger_pedido",
    "actuarBrazo",
    "iniciar_recorrido",
}

_VERIFICATION_PROMPTS: Dict[str, str] = {
    "ir_a_lugar": (
        "Verifica si el robot llegó correctamente a {lugar}. "
        "¿El entorno corresponde al lugar esperado? "
        "Responde SÍ o NO seguido de una breve descripción de lo que ves."
    ),
    "entregar_pedido": (
        "Verifica si el robot ha entregado el pedido. "
        "¿La bandeja del robot está vacía o con menos ítems? "
        "¿Los platos o bebidas están sobre la mesa? "
        "Responde SÍ o NO seguido de una breve descripción."
    ),
    "recoger_pedido": (
        "Verifica si el robot ha recogido el pedido de cocina. "
        "¿Hay ítems visibles en la bandeja del robot? "
        "Responde SÍ o NO seguido de una breve descripción."
    ),
    "actuarBrazo": (
        "Verifica si el brazo robótico completó el movimiento esperado. "
        "¿El brazo está en la posición final correcta? "
        "Responde SÍ o NO seguido de una breve descripción."
    ),
    "iniciar_recorrido": (
        "Verifica si el robot está navegando hacia su destino. "
        "¿El camino al frente está despejado? "
        "Responde SÍ o NO seguido de una breve descripción."
    ),
}


class ExecutionChecker:
    """
    Post-action visual verification engine.

    Captures a camera frame after a critical action completes, sends it
    to the vision model with a targeted verification prompt, parses the
    response, and triggers re-planning on failure.

    Usage::

        checker = ExecutionChecker(vision_client, memory=mem, logger=print)
        result = await checker.verify_action("ir_a_lugar", {"lugar": "MESA_3"}, action_result)
        if not result["success"]:
            replan = await checker.handle_verification_failure(
                "ir_a_lugar", {"lugar": "MESA_3"}, result, gemini_client
            )
    """

    def __init__(
        self,
        vision_client: Any,
        memory: Any = None,
        logger: Any = None,
        max_replan_attempts: int = 2,
    ) -> None:
        self.vision = vision_client
        self.memory = memory
        self.logger = logger or (lambda msg: None)
        self.max_replan_attempts = max_replan_attempts
        self.stats: Dict[str, int] = {"verified": 0, "passed": 0, "failed": 0}
        self.verification_log: List[Dict[str, Any]] = []

    # ── Public API ─────────────────────────────────────────────────────────

    @classmethod
    def should_verify(cls, action_name: str) -> bool:
        """Return True if action warrants visual verification."""
        return action_name in VERIFIABLE_ACTIONS

    async def verify_action(
        self,
        action_name: str,
        args: Dict[str, Any],
        action_result: Dict[str, Any],
    ) -> Dict[str, Any]:
        t0 = time.monotonic()

        if not self.should_verify(action_name):
            return {"success": True, "verified": False, "reason": "not_verifiable"}

        if action_result.get("success") is False:
            return {
                "success": False,
                "verified": False,
                "reason": action_result.get("error", "action_reported_failure"),
            }

        prompt = self._build_prompt(action_name, args)

        try:
            raw = await self.vision.query(prompt)
            description = raw.get("description", "")
            success = self._parse_yes_no(description, action_name)

            self.stats["verified"] += 1
            if success:
                self.stats["passed"] += 1
            else:
                self.stats["failed"] += 1

            entry = {
                "action": action_name,
                "args": args,
                "success": success,
                "description": description[:500],
                "latency_ms": round((time.monotonic() - t0) * 1000, 1),
                "timestamp": time.time(),
            }
            self.verification_log.append(entry)

            if self.memory:
                self._log_to_memory(entry)

            return {
                "success": success,
                "verified": True,
                "description": description,
                "latency_ms": entry["latency_ms"],
            }

        except Exception as exc:
            self.logger(f"[ExecutionChecker] verify_action error: {exc}")
            return {
                "success": True,
                "verified": False,
                "reason": f"verification_error: {exc}",
            }

    async def handle_verification_failure(
        self,
        action_name: str,
        args: Dict[str, Any],
        verification_result: Dict[str, Any],
        or_client: Any = None,
        attempt: int = 1,
    ) -> Dict[str, Any]:
        if attempt > self.max_replan_attempts:
            return {"alternative_action": None, "reason": "max_replan_attempts_exceeded"}

        if not or_client:
            return {"alternative_action": None, "reason": "no_openrouter_client"}

        prompt = (
            f"Eres Uchino, un robot mesero del campus UTEC. "
            f"La acción '{action_name}' con argumentos {json.dumps(args)} "
            f"parece no haberse completado correctamente.\n"
            f"Lo que observo con mi cámara: {verification_result.get('description', 'sin descripción')}\n\n"
            f"Propón UNA acción correctiva simple como JSON con campos 'name' y 'args'. "
            f"Acciones válidas: ir_a_lugar, entregar_pedido, recoger_pedido, actuarBrazo, "
            f"iniciar_recorrido, confirmar_pedido, cancelar_pedido.\n"
            f"Si no hay alternativa viable, responde exactamente: NO_ALTERNATIVA"
        )

        try:
            import asyncio
            response = await asyncio.to_thread(
                or_client.chat.completions.create,
                model=os.environ.get("OPENROUTER_MODEL", "deepseek/deepseek-v4-flash"),
                messages=[{"role": "user", "content": prompt}],
                max_tokens=200,
            )
            text = response.choices[0].message.content or "NO_ALTERNATIVA"
        except Exception as exc:
            self.logger(f"[ExecutionChecker] LLM re-plan error: {exc}")
            return {"alternative_action": None, "reason": str(exc)}

        if "NO_ALTERNATIVA" in text:
            return {"alternative_action": None, "reason": "llm_no_alternative"}

        try:
            json_start = text.find("{")
            json_end = text.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                alt = json.loads(text[json_start:json_end])
                return {
                    "alternative_action": {
                        "name": alt["name"],
                        "args": alt.get("args", {}),
                    }
                }
        except (json.JSONDecodeError, KeyError):
            pass

        return {"alternative_action": None, "reason": "unparseable_llm_response"}

    # ── Internal helpers ────────────────────────────────────────────────────

    def _build_prompt(self, action_name: str, args: Dict[str, Any]) -> str:
        """Build a verification prompt from action name and args."""
        template = _VERIFICATION_PROMPTS.get(action_name)
        if template:
            try:
                return template.format(**args)
            except KeyError:
                pass

        args_str = ", ".join(f"{k}={v}" for k, v in args.items()) if args else "sin argumentos"
        return (
            f"Verifica visualmente si la acción '{action_name}' ({args_str}) "
            f"se completó correctamente. Responde SÍ o NO con una breve descripción."
        )

    @staticmethod
    def _parse_yes_no(description: str, action_name: str) -> bool:
        text = description.lower().strip()

        if text.startswith("sí") or text.startswith("si "):
            return True
        if text.startswith("no ") and not text.startswith("no sé"):
            return False

        positive_kw = [
            "correctamente", "completado", "exitoso", "llegó", "entregado",
            "visible", "presente", "cerca", "correcto", "éxito", "despejado",
        ]
        negative_kw = [
            "no pudo", "falló", "obstáculo", "bloqueado", "incorrecto",
            "no visible", "vacío", "ausente", "no llegó", "error",
            "no se ve", "no está",
        ]

        pos_score = sum(1 for kw in positive_kw if kw in text)
        neg_score = sum(1 for kw in negative_kw if kw in text)

        return pos_score > neg_score

    def _log_to_memory(self, entry: Dict[str, Any]) -> None:
        """Persist verification result for future rule extraction (SYNAPSE/BrainMem)."""
        try:
            outcome = "éxito" if entry["success"] else "fallo"
            self.memory.add(
                messages=[{
                    "role": "system",
                    "content": (
                        f"[VERIFICACION] Acción: {entry['action']} | "
                        f"Resultado: {outcome} | "
                        f"Args: {json.dumps(entry.get('args', {}), ensure_ascii=False)} | "
                        f"Descripción visual: {entry['description']}"
                    ),
                }],
                user_id="execution_checker",
                metadata={
                    "categoria": "verificacion_accion",
                    "action": entry["action"],
                    "success": entry["success"],
                    "timestamp": entry["timestamp"],
                },
            )
        except Exception as exc:
            self.logger(f"[ExecutionChecker] Memory log error: {exc}")

    def get_summary(self) -> Dict[str, Any]:
        """Return current verification statistics."""
        return {
            "stats": self.stats,
            "recent": self.verification_log[-5:] if self.verification_log else [],
            "total_verified": len(self.verification_log),
        }
