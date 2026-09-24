import asyncio
import os
import time
import uuid
from typing import Dict, Any, Optional, List

from openai import OpenAI

from .fast_rules import FastRuleEngine
from .ros2_bridge import Ros2Bridge
from .vision_client import VisionClient

try:
    from ..dialogue import DialogueGraph, create_dialogue_graph, DEFAULT_STATE
    from ..dialogue.state_machine import DialogueState
    HAS_DIALOGUE = True
except ImportError:
    HAS_DIALOGUE = False
    DialogueGraph = None
    create_dialogue_graph = None
    DEFAULT_STATE = {}
    DialogueState = dict

try:
    from ..memory import get_memory, PersonMemory
    HAS_MEMORY = True
except ImportError:
    HAS_MEMORY = False
    get_memory = None
    PersonMemory = None

try:
    from ..tts import TTSManager
    HAS_TTS = True
except ImportError:
    HAS_TTS = False
    TTSManager = None

try:
    from ..vision.execution_checker import ExecutionChecker
    HAS_EXECUTION_CHECKER = True
except ImportError:
    HAS_EXECUTION_CHECKER = False
    ExecutionChecker = None

try:
    from ..emotion.emotion_pipeline import EmotionPipeline
    HAS_EMOTION = True
except ImportError:
    HAS_EMOTION = False
    EmotionPipeline = None


# ── OpenRouter client (OpenAI-compatible) ──────────────────────────
_OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
_OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL",
                                       "https://openrouter.ai/api/v1")
_OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL", "deepseek/deepseek-v4-flash")
_OPENROUTER_FALLBACK_MODEL = os.environ.get("OPENROUTER_FALLBACK_MODEL", "meta-llama/llama-3.1-8b-instruct")
_OPENROUTER_VISION_FALLBACK_MODEL = os.environ.get("OPENROUTER_VISION_FALLBACK_MODEL", "qwen/qwen3-vl-8b-instruct")

_OR_CLIENT: OpenAI | None = None
if _OPENROUTER_API_KEY:
    _OR_CLIENT = OpenAI(api_key=_OPENROUTER_API_KEY, base_url=_OPENROUTER_BASE_URL)


class MasterOrchestrator:
    SYSTEM2_MAX_HZ = 8.0
    SYSTEM2_MIN_INTERVAL = 1.0 / SYSTEM2_MAX_HZ
    MAX_REPLAN_ATTEMPTS = 2

    def __init__(
        self,
        backend_url: str = "http://localhost:3005",
        enable_vision_verify: bool = True,
        logger=None,
    ):
        self.logger = logger or print
        self.backend_url = backend_url
        self.enable_vision_verify = enable_vision_verify
        self.last_system2_time = 0.0
        self.replan_attempts = 0

        self._session_state: Dict[str, Dict[str, Any]] = {}

        self.fast_rules = FastRuleEngine(logger=self.logger)
        self.ros2 = Ros2Bridge(base_url=backend_url, logger=self.logger)
        self.vision = VisionClient(base_url=backend_url, logger=self.logger)

        self.execution_checker = None
        if HAS_EXECUTION_CHECKER:
            self.execution_checker = ExecutionChecker(
                vision_client=self.vision,
                memory=None,
                logger=self.logger,
            )

        self.dialogue = None
        if HAS_DIALOGUE:
            try:
                self.dialogue = create_dialogue_graph(
                    use_gemini=False,
                )
            except Exception as exc:
                self.logger(f"[Orchestrator] Dialogue init failed: {exc}")

        self._menu_cache = None
        self._menu_cache_at = 0.0

        legacy_memory_enabled = os.getenv('LEGACY_UNSCOPED_MEMORY_ENABLED', '').lower() in {'1', 'true', 'yes'}
        self.memory = None
        if HAS_MEMORY and legacy_memory_enabled:
            try:
                self.memory = get_memory()
            except Exception as exc:
                self.logger(f"[Orchestrator] Memory init failed: {exc}")

        if self.execution_checker and self.memory:
            self.execution_checker.memory = self.memory

        self.person_memory = None
        if HAS_MEMORY and PersonMemory and legacy_memory_enabled:
            try:
                self.person_memory = PersonMemory()
            except Exception as exc:
                self.logger(f"[Orchestrator] PersonMemory init failed: {exc}")

        self.tts = None
        if HAS_TTS:
            try:
                self.tts = TTSManager()
            except Exception as exc:
                self.logger(f"[Orchestrator] TTS init failed: {exc}")

        self._or_client = _OR_CLIENT

        self._emotion = None
        if HAS_EMOTION:
            try:
                self._emotion = EmotionPipeline()
            except Exception as exc:
                self.logger(f"[Orchestrator] EmotionPipeline init failed: {exc}")

    async def process_input(
        self,
        input_type: str,
        data: Any,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        metadata = metadata or {}
        if not metadata.get("session_id"):
            metadata["session_id"] = "default-" + str(uuid.uuid4())[:8]
        session_id = metadata["session_id"]
        metadata.setdefault("current_state", self._get_current_state(session_id))

        if input_type == "telemetry":
            self.fast_rules.update_telemetry(data)
            fast_result = self.fast_rules.evaluate("telemetry", data)
            if fast_result:
                return await self._execute_fast_result(fast_result, metadata=metadata)
            return {"handled": False, "reason": "telemetry_no_action"}

        if input_type in {"text", "asr_result"}:
            text = data.get("transcript", data) if isinstance(data, dict) else str(data)
            fast_result = self.fast_rules.evaluate("text", text, metadata)
            if fast_result and fast_result.get("action") == "immediate":
                return await self._execute_fast_result(fast_result, session_id, metadata)
            return await self._slow_path_text(text, metadata)

        if input_type == "image":
            prompt = metadata.get("prompt", "¿Qué ves en esta imagen?")
            return await self._slow_path_image(data, prompt, metadata)

        return {"error": "unknown_input_type", "input_type": input_type}

    async def _execute_fast_result(
        self,
        fast_result: Dict[str, Any],
        session_id: str = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        command = fast_result.get("command")
        response_text = fast_result.get("response_text", "")
        emotion = fast_result.get("emotion", "neutral")
        next_state = fast_result.get("next_state")

        if command == "emergency_stop" or command == "stop":
            await self.ros2.stop()

        if command == "go_to_base":
            await self.ros2.go_to("BASE")

        if command == "nav_cancel":
            await self.ros2.stop()

        if next_state:
            self._update_state(next_state, session_id)

        tts_result = None
        if response_text and self.tts and not (metadata or {}).get("tts_deferred"):
            tts_result = self.tts.synthesize_with_engine(response_text, emotion=emotion)

        return {
            "system": "system1",
            "action": command,
            "response_text": response_text,
            "emotion": emotion,
            "tts": tts_result,
            "next_state": next_state,
            "latency_ms": 0,
        }

    async def _slow_path_text(self, text: str, metadata: Dict[str, Any]) -> Dict[str, Any]:
        now = time.monotonic()
        elapsed = now - self.last_system2_time
        if elapsed < self.SYSTEM2_MIN_INTERVAL:
            await asyncio.sleep(self.SYSTEM2_MIN_INTERVAL - elapsed)
        self.last_system2_time = time.monotonic()

        t0 = time.monotonic()

        state = await self._load_or_create_state(metadata)
        session_id = state["session_id"]
        state["user_input"] = text
        state["wake_word_detected"] = metadata.get("wake_word_detected", False)
        state["ui_touch"] = metadata.get("ui_touch", False)
        state["emotion"] = metadata.get("emotion")
        state["mesa"] = metadata.get("mesa") or state.get("mesa")
        state["customer_id"] = metadata.get("client_id") or metadata.get("customer_id") or state.get("customer_id")
        sess_meta = self._get_session_state(session_id)
        if state.get("mesa"):
            sess_meta["mesa"] = state["mesa"]
        if state.get("customer_id"):
            sess_meta["customer_id"] = state["customer_id"]

        # Detect customer emotion from text (if pipeline available)
        customer_emotion = None
        if self._emotion:
            try:
                result = self._emotion.detect_from_text(text)
                if result:
                    customer_emotion = result.get("emotion", result.get("sentiment"))
            except Exception as exc:
                self.logger(f"[Orchestrator] Emotion detection error: {exc}")
        state["customer_emotion"] = customer_emotion

        if self.person_memory and state.get("customer_id"):
            profile = self.person_memory.extract_profile(state["customer_id"])
            preferences = self.person_memory.get_preferences(state["customer_id"])
            state["customer_name"] = profile.get("nombre") or state.get("customer_name")
            state["customer_preferences"] = {"profile": profile, "preferences": preferences}

        if not self.dialogue:
            return await self._fallback_slow_path(text, state, metadata)

        try:
            result_state = self.dialogue.process_turn(
                session_id=state["session_id"],
                user_input=text,
                wake_word=state.get("wake_word_detected", False),
                ui_touch=state.get("ui_touch", False),
                customer_finished=True,
                mesa=state.get("mesa"),
                customer_id=state.get("customer_id"),
            )
        except Exception as exc:
            self.logger(f"[Orchestrator] Dialogue error: {exc}")
            result_state = None

        if result_state is None:
            response_text = "Estoy procesando tu mensaje. Un momento por favor."
            actions = []
            current_state = state.get("current_state", "idle")
        else:
            response_text = result_state.get("response", "Entendido.")
            actions = result_state.get("actions", [])
            current_state = result_state.get("current_state", "idle")
            self.logger(f"[Orchestrator-DBG] session={session_id} dialogue_actions={actions} mesa={state.get('mesa')!r}")

        if not actions and self._or_client and text and current_state in ("taking_order", "greeting", "idle"):
            try:
                import json
                menu_payload = await self._fetch_menu_text()
                system_prompt = self._build_fallback_system_prompt(menu_payload, state, session_id)
                tool_def = self._function_tools_definition()
                self.logger(f"[Orchestrator-FB] session={session_id} mesa={state.get('mesa')!r} state_mesa={self._get_session_state(session_id).get('mesa')!r} current={current_state}")
                self.logger(f"[Orchestrator-FB] system_prompt[:300]={system_prompt[:300]!r}")
                response = await asyncio.to_thread(
                    self._or_client.chat.completions.create,
                    model=_OPENROUTER_MODEL,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": text},
                    ],
                    tools=tool_def,
                    tool_choice="auto",
                    temperature=0.2,
                    max_tokens=400,
                    timeout=20,
                )
                msg = response.choices[0].message
                self.logger(f"[Orchestrator-FB] response content={msg.content!r} tool_calls={msg.tool_calls}")
                if msg.content:
                    response_text = msg.content
                if msg.tool_calls:
                    for tc in msg.tool_calls:
                        fn = tc.function
                        try:
                            args = json.loads(fn.arguments) if isinstance(fn.arguments, str) else (fn.arguments or {})
                        except Exception:
                            args = {}
                        actions.append({"name": fn.name, "args": args})
            except Exception as exc:
                self.logger(f"[Orchestrator] Fallback LLM error: {exc}")

        self._update_state(current_state, session_id)

        executed_actions = []
        for action in actions:
            action_name = action.get("name")
            action_args = action.get("args", {})

            safe, reason = self.fast_rules.validate_action(action_name, action_args, current_state)
            if not safe:
                response_text += f"\n[Seguridad: {reason}]"
                executed_actions.append({"name": action_name, "args": action_args, "blocked": True, "reason": reason})
                continue

            exec_result = await self._execute_action(action_name, action_args, session_id=session_id)
            executed_actions.append({"name": action_name, "args": action_args, "result": exec_result})
            if action_name == "registrar_pedido" and isinstance(exec_result, dict):
                pedido = exec_result.get("pedido") or {}
                if isinstance(pedido, dict) and pedido.get("id"):
                    self._get_session_state(session_id)["last_pedido_id"] = pedido["id"]
                elif action_args.get("pedido_id"):
                    self._get_session_state(session_id)["last_pedido_id"] = action_args["pedido_id"]

            should_verify = (
                self.enable_vision_verify
                and self.execution_checker
                and self.execution_checker.should_verify(action_name)
            )

            if exec_result.get("success") is False and self.enable_vision_verify:
                replan = await self._handle_failure(action_name, action_args, exec_result)
                if replan.get("alternative_action"):
                    alt = replan["alternative_action"]
                    alt_result = await self._execute_action(alt["name"], alt["args"])
                    executed_actions.append({"name": alt["name"], "args": alt["args"], "result": alt_result, "replan": True})
                    if alt_result.get("success") is False:
                        response_text += f"\nLo siento, no pude completar la acción después de intentar una alternativa."
                else:
                    response_text += f"\nLo siento, no pude completar la acción. {replan.get('reason', '')}"
            elif should_verify:
                verified = await self._verify_execution(action_name, action_args, exec_result)
                if not verified.get("success"):
                    replan = await self._handle_failure(action_name, action_args, verified)
                    if replan.get("alternative_action"):
                        alt = replan["alternative_action"]
                        alt_result = await self._execute_action(alt["name"], alt["args"])
                        executed_actions.append({"name": alt["name"], "args": alt["args"], "result": alt_result, "replan": True})

        if self.person_memory and state.get("customer_id"):
            self.person_memory.record_interaction(
                user_id=state["customer_id"],
                messages=[
                    {"role": "user", "content": text},
                    {"role": "assistant", "content": response_text},
                ],
            )

        tts_result = None
        if response_text and self.tts and not metadata.get("tts_deferred"):
            emotion = (result_state or {}).get("emotion", "feliz")
            tts_result = self.tts.synthesize_with_engine(response_text, emotion=emotion)

        latency_ms = round((time.monotonic() - t0) * 1000, 1)

        return {
            "system": "system2",
            "current_state": current_state,
            "response_text": response_text,
            "emotion": result_state.get("emotion", "neutral"),
            "actions": executed_actions,
            "tts": tts_result,
            "session_id": state["session_id"],
            "latency_ms": latency_ms,
        }

    async def _slow_path_image(self, image_b64: str, prompt: str, metadata: Dict[str, Any]) -> Dict[str, Any]:
        if not self._or_client:
            return {"error": "vision_not_available", "response_text": "No puedo procesar imágenes ahora mismo."}

        t0 = time.monotonic()

        text = await self._try_vision_model(_OPENROUTER_MODEL, image_b64, prompt)

        # ── Cascade: (2) Qwen3 VL 8B (vision-only) → DeepSeek V4 Flash ────
        if not text:
            self.logger("[Orchestrator] Modelo primario de visión falló, probando Qwen3 VL 8B...")
            vision_desc = await self._try_vision_model(
                _OPENROUTER_VISION_FALLBACK_MODEL, image_b64, prompt
            )
            if vision_desc:
                self.logger("[Orchestrator] Qwen3 VL OK, refinando con DeepSeek V4 Flash...")
                text = await self._try_text_refine(vision_desc, prompt)
            else:
                self.logger("[Orchestrator] Qwen3 VL también falló — sin respuesta visual.")
                text = "No pude analizar la imagen."

        # ── Cascade: (3) Ollama local (fallback final) ──────────────────────
        if not text or text in ("No pude analizar la imagen.",):
            self.logger("[Orchestrator] Todos los modelos cloud fallaron, probando Ollama...")
            text = await self._try_ollama_vision(image_b64, prompt)

        final_text = text or "No pude procesar la imagen en este momento."

        tts_result = None
        if self.tts and not metadata.get("tts_deferred"):
            tts_result = self.tts.synthesize_with_engine(final_text, emotion="neutral")

        return {
            "system": "system2",
            "input_type": "image",
            "response_text": final_text,
            "tts": tts_result,
            "latency_ms": round((time.monotonic() - t0) * 1000, 1),
        }

    async def _try_vision_model(self, model: str, image_b64: str, prompt: str) -> str | None:
        try:
            response = await asyncio.to_thread(
                self._or_client.chat.completions.create,
                model=model,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url",
                             "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                        ],
                    },
                ],
                max_tokens=500,
                timeout=30,
            )
            text = response.choices[0].message.content
            if text and text.strip():
                return text.strip()
        except Exception as exc:
            self.logger(f"[Orchestrator] Vision error con {model}: {exc}")
        return None

    async def _try_text_refine(self, vision_description: str, original_prompt: str) -> str | None:
        refine_prompt = (
            f"Eres Uchino, el robot mesero de la UTEC. Un cliente te preguntó:\n"
            f"'{original_prompt}'\n\n"
            f"Esto es lo que ves con tu cámara:\n{vision_description}\n\n"
            f"Responde al cliente en español peruano, con jerga natural y calidez. "
            f"Sé breve y directo. Usa frases como 'al toque', 'chévere', 'claro pe' cuando sea apropiado."
        )
        try:
            response = await asyncio.to_thread(
                self._or_client.chat.completions.create,
                model=_OPENROUTER_FALLBACK_MODEL,
                messages=[{"role": "user", "content": refine_prompt}],
                max_tokens=300,
                timeout=20,
            )
            text = response.choices[0].message.content
            if text and text.strip():
                return text.strip()
        except Exception as exc:
            self.logger(f"[Orchestrator] Text refine error con {_OPENROUTER_FALLBACK_MODEL}: {exc}")
        return None

    async def _try_ollama_vision(self, image_b64: str, prompt: str) -> str | None:
        ollama_host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
        ollama_model = os.environ.get("QWEN35_9B_MODEL", "qwen3.5:9b")
        import httpx
        try:
            async with httpx.AsyncClient(timeout=45.0) as client:
                resp = await client.post(
                    f"{ollama_host}/api/chat",
                    json={
                        "model": ollama_model,
                        "messages": [
                            {
                                "role": "user",
                                "content": prompt,
                                "images": [image_b64],
                            },
                        ],
                        "stream": False,
                        "options": {"num_predict": 300},
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    text = data.get("message", {}).get("content", "")
                    if text and text.strip():
                        return text.strip()
                else:
                    self.logger(f"[Orchestrator] Ollama vision HTTP {resp.status_code}")
        except Exception as exc:
            self.logger(f"[Orchestrator] Ollama vision error: {exc}")
        return None

    async def _execute_action(self, action_name: str, args: Dict[str, Any], session_id: str = None) -> Dict[str, Any]:
        sess = self._get_session_state(session_id) if session_id else None
        if action_name == "ir_a_lugar":
            destino = args.get("lugar", "BASE")
            return await self.ros2.go_to(destino)
        if action_name == "iniciar_recorrido":
            pedido_id = args.get("pedido_id", str(uuid.uuid4())[:8])
            mesa = args.get("mesa", "1")
            return await self.ros2.iniciar_recorrido(pedido_id, mesa)
        if action_name == "confirmar_pedido":
            pedido_id = (
                args.get("pedido_id")
                or args.get("id")
                or (sess.get("last_pedido_id") if sess else None)
            )
            if pedido_id and self.backend_url:
                try:
                    import aiohttp
                    async with aiohttp.ClientSession() as s:
                        url = f"{self.backend_url}/api/pedidos/{pedido_id}/confirmar"
                        async with s.post(url, json={"status": "confirmed"}) as r:
                            data = await r.json()
                            if r.status < 400 and sess is not None:
                                sess["last_pedido_id"] = None
                            return {"success": r.status < 400, "pedido": data}
                except Exception as exc:
                    self.logger(f"[Orchestrator] confirmar_pedido backend error: {exc}")
            return {"success": True, "status": "confirmed"}
        if action_name == "cancelar_pedido":
            pedido_id = (
                args.get("pedido_id")
                or args.get("id")
                or (sess.get("last_pedido_id") if sess else None)
            )
            if pedido_id and self.backend_url:
                try:
                    import aiohttp
                    async with aiohttp.ClientSession() as s:
                        url = f"{self.backend_url}/api/pedidos/{pedido_id}/cancelar"
                        async with s.post(url, json={"status": "cancelled"}) as r:
                            data = await r.json()
                            if r.status < 400 and sess is not None:
                                sess["last_pedido_id"] = None
                            return {"success": r.status < 400, "pedido": data}
                except Exception as exc:
                    self.logger(f"[Orchestrator] cancelar_pedido backend error: {exc}")
            return {"success": True, "status": "cancelled"}
        if action_name == "registrar_pedido":
            if self.backend_url:
                try:
                    import aiohttp
                    payload = {
                        "mesa": args.get("mesa", "1"),
                        "platos": args.get("platos", []),
                        "bebida": args.get("bebida"),
                        "total": args.get("total", 0),
                        "status": "draft",
                        "mode": "voice",
                    }
                    async with aiohttp.ClientSession() as s:
                        url = f"{self.backend_url}/api/pedidos"
                        async with s.post(url, json=payload) as r:
                            data = await r.json()
                            return {"success": r.status < 400, "pedido": data}
                except Exception as exc:
                    self.logger(f"[Orchestrator] registrar_pedido backend error: {exc}")
            return {"success": True, "pedido": args}
        if action_name == "expresar_emocion":
            return {"success": True, "emotion": args.get("emocion", "neutral")}
        if action_name == "guardar_memoria":
            if self.memory:
                self.memory.add(
                    messages=[{"role": "user", "content": f"{args.get('clave')}: {args.get('valor')}"}],
                    user_id=args.get("user_id", "default"),
                    metadata={"categoria": args.get("categoria", "hecho")},
                )
            return {"success": True}
        if action_name == "verificar_accion":
            target_action = args.get("accion", "desconocida")
            expected = args.get("resultado_esperado", "")
            return await self._verify_execution(target_action, args)
        return {"success": False, "error": f"Unknown action: {action_name}"}

    async def _verify_execution(self, action_name: str, args: Dict[str, Any], exec_result: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if not self.enable_vision_verify:
            return {"success": True, "skipped": True}

        if self.execution_checker:
            return await self.execution_checker.verify_action(
                action_name, args, exec_result or {"success": True}
            )

        return await self.vision.verify_action(action_name, f"{action_name} con {args}")

    async def _handle_failure(self, action_name: str, args: Dict[str, Any], failure_result: Dict[str, Any]) -> Dict[str, Any]:
        if self.replan_attempts >= self.MAX_REPLAN_ATTEMPTS:
            self.replan_attempts = 0
            return {"alternative_action": None, "reason": "Max re-plan attempts reached."}

        self.replan_attempts += 1

        if self.execution_checker and failure_result.get("verified") and self._or_client:
            return await self.execution_checker.handle_verification_failure(
                action_name, args, failure_result, or_client=self._or_client
            )

        if not self._or_client:
            return {"alternative_action": None, "reason": "OpenRouter not available for re-planning."}

        prompt = (
            f"Eres el cerebro de planificación de un robot mesero llamado Uchino. "
            f"La acción '{action_name}' con argumentos {args} falló. "
            f"Resultado del error: {failure_result.get('error', 'Unknown error')}. "
            f"Propón UNA acción alternativa simple como JSON con campos 'name' y 'args'. "
            f"Si no hay alternativa viable, responde exactamente: NO_ALTERNATIVA"
        )

        try:
            response = await asyncio.to_thread(
                self._or_client.chat.completions.create,
                model=_OPENROUTER_MODEL,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=200,
            )
            text = response.choices[0].message.content or "NO_ALTERNATIVA"
        except Exception as exc:
            self.logger(f"[Orchestrator] Re-plan error: {exc}")
            return {"alternative_action": None, "reason": str(exc)}

        if "NO_ALTERNATIVA" in text:
            return {"alternative_action": None, "reason": "Model found no alternative."}

        import json
        try:
            json_start = text.find("{")
            json_end = text.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                alt = json.loads(text[json_start:json_end])
                return {"alternative_action": {"name": alt["name"], "args": alt.get("args", {})}}
        except (json.JSONDecodeError, KeyError):
            pass

        return {"alternative_action": None, "reason": "Could not parse re-plan response."}

    async def _fallback_slow_path(
        self,
        text: str,
        state: Dict[str, Any],
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        response_text = "Estoy procesando tu solicitud..."
        tts_result = None
        if self.tts and not (metadata or {}).get("tts_deferred"):
            tts_result = self.tts.synthesize_with_engine(response_text, emotion="pensando")
        return {
            "system": "system2",
            "current_state": state.get("current_state", "idle"),
            "response_text": response_text,
            "tts": tts_result,
            "fallback": True,
        }

    async def _load_or_create_state(self, metadata: Dict[str, Any]) -> Dict[str, Any]:
        session_id = metadata.get("session_id")
        if not session_id:
            session_id = "default-" + str(uuid.uuid4())[:8]
            metadata["session_id"] = session_id
        if self.dialogue and hasattr(self.dialogue, "checkpoint"):
            try:
                checkpoint = self.dialogue.checkpoint.load(session_id)
                if checkpoint:
                    checkpoint["session_id"] = session_id
                    return checkpoint
            except Exception:
                pass
        state = dict(DEFAULT_STATE)
        state["session_id"] = session_id
        return state

    def _get_session_state(self, session_id: str) -> Dict[str, Any]:
        if not session_id:
            session_id = "default"
        if session_id not in self._session_state:
            self._session_state[session_id] = {
                "current_state": "idle",
                "mesa": None,
                "customer_id": None,
                "last_pedido_id": None,
            }
        return self._session_state[session_id]

    def _get_current_state(self, session_id: str = None) -> str:
        if session_id:
            return self._get_session_state(session_id).get("current_state", "idle")
        return "idle"

    def _update_state(self, state: str, session_id: str = None):
        if session_id:
            self._get_session_state(session_id)["current_state"] = state

    async def _fetch_menu_text(self) -> str:
        if self._menu_cache and (time.monotonic() - self._menu_cache_at) < 60:
            return self._menu_cache
        try:
            import aiohttp
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as s:
                url = f"{self.backend_url}/api/menu"
                async with s.get(url) as r:
                    if r.status == 200:
                        data = await r.json()
                        items = data.get("data", []) if isinstance(data, dict) else data
                        lines = []
                        for m in items or []:
                            lines.append(f"- {m.get('nombre')} (S/. {m.get('precio')}) [{m.get('categoria', 'general')}]")
                        self._menu_cache = "\n".join(lines) if lines else "(menú no disponible)"
                        self._menu_cache_at = time.monotonic()
                        return self._menu_cache
        except Exception as exc:
            self.logger(f"[Orchestrator] menu fetch error: {exc}")
        return self._menu_cache or "(menú no disponible)"

    def _build_fallback_system_prompt(self, menu_text: str, state: Dict[str, Any], session_id: str = None) -> str:
        mesa = state.get("mesa") or (self._get_session_state(session_id).get("mesa") if session_id else None) or "?"
        cid = state.get("customer_id") or (self._get_session_state(session_id).get("customer_id") if session_id else None) or "cliente"
        current = self._get_current_state(session_id)
        last_pid = (self._get_session_state(session_id).get("last_pedido_id") if session_id else None) or ""
        return (
            "Eres Uchino, robot mesero de la cafetería de UTEC en Lima, Perú. "
            "Responde en español peruano, breve y cálido. "
            "Estado actual de la conversación: " + current + ". "
            "Reglas de function calling (NO negociables):\n"
            "1. Si el cliente NOMBRA uno o varios productos del menú (estado 'idle', 'greeting' o 'taking_order'), DEBES llamar a registrar_pedido con mesa=\"" + str(mesa) + "\", platos=[{nombre, cantidad, precio}], bebida opcional, total. clienteId=" + str(cid) + ".\n"
            "2. Si el cliente CONFIRMA ('sí', 'confirmo', 'dale', 'va', 'eso es', 'correcto', etc.) y ya hay un pedido en borrador, DEBES llamar a confirmar_pedido con pedido_id=\"" + str(last_pid) + "\".\n"
            "3. Si el cliente CANCELA ('no', 'cancela', 'mejor no', 'déjalo'), DEBES llamar a cancelar_pedido con pedido_id=\"" + str(last_pid) + "\".\n"
            "4. Si el cliente solo conversa o agradece, NO llames funciones; responde breve y cálido.\n"
            "5. NUNCA digas 'listo' o 'ya está' sin haber llamado la función correspondiente.\n"
            "MENÚ DISPONIBLE (usa estos nombres y precios EXACTOS):\n" + menu_text
        )

    def _function_tools_definition(self) -> list:
        return [
            {
                "type": "function",
                "function": {
                    "name": "registrar_pedido",
                    "description": "Registra el pedido provisional del cliente.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "mesa": {"type": "string"},
                            "platos": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "nombre": {"type": "string"},
                                        "cantidad": {"type": "number"},
                                        "precio": {"type": "number"},
                                    },
                                },
                            },
                            "bebida": {"type": "string"},
                            "total": {"type": "number"},
                        },
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "confirmar_pedido",
                    "description": "Confirma el pedido en borrador.",
                    "parameters": {
                        "type": "object",
                        "properties": {"pedido_id": {"type": "string"}},
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "cancelar_pedido",
                    "description": "Cancela el pedido en borrador.",
                    "parameters": {
                        "type": "object",
                        "properties": {"pedido_id": {"type": "string"}},
                    },
                },
            },
        ]

    async def shutdown(self):
        if self.tts and hasattr(self.tts, "shutdown"):
            self.tts.shutdown()
