"""
Dialogue Integrator — Connects PLN with LangGraph dialogue and LLM providers.

Routes text through:
1. Fast rules (greeting, farewell, emergency) → immediate response
2. LLM bridge (DeepSeek V4 Flash) → conversational response
3. Vision pipeline (Qwen3 VL 8B → DeepSeek V4 Flash) → image-aware response
"""

import asyncio
import json
import logging
from typing import Optional

import httpx

from .types import ChipiState, DialogueContext, PLNResponse, OrderItem
from .config import (
    BACKEND_URL, LLM_BRIDGE_URL, MENU_URL,
    PRIMARY_LLM, FALLBACK_LLM, OFFLINE_LLM,
    VISION_LLM, OPENROUTER_URL, OPENROUTER_API_KEY,
    LLM_TIMEOUT
)
from .states import CHIPI_TO_DIALOGUE, DIALOGUE_TO_CHIPI

logger = logging.getLogger(__name__)

FAST_RULES = {
    "greeting": {
        "keywords": ["hola", "buenas", "buenos días", "buenas tardes", "buenas noches", "hey", "oe"],
        "response": "¡Hola causa! Bienvenido a Uchino. ¿Qué te provoca hoy?",
        "next_state": ChipiState.LISTENING,
    },
    "intro": {
        "keywords": ["me llamo", "mi nombre es", "yo soy", "soy"],
        "response": "__CUSTOM_INTRO__",
        "next_state": ChipiState.LISTENING,
    },
    "farewell": {
        "keywords": ["gracias", "chao", "adiós", "hasta luego", "nos vemos", "ya está"],
        "response": "¡Hasta la próxima, pata! Que te vaya chevere.",
        "next_state": ChipiState.SLEEP,
    },
    "emergency": {
        "keywords": ["ayuda", "emergencia", "socorro", "auxilio"],
        "response": "¡Tranquilo! Ya viene alguien a ayudarte. ¿Necesitas algo más?",
        "next_state": ChipiState.LISTENING,
    },
    "cancel": {
        "keywords": ["cancelar", "ya no quiero", "nada", "olvida", "déjalo"],
        "response": "No hay problema, causa. ¿Quieres algo más o ya estamos?",
        "next_state": ChipiState.LISTENING,
    },
}


class DialogueIntegrator:
    """Integrates PLN with LangGraph dialogue and LLM providers.
    
    Handles:
    - Fast rule detection (greeting, farewell, emergency, cancel)
    - LLM calls via backend bridge with fallback chain
    - Vision pipeline (Qwen3 VL 8B describes → DeepSeek V4 Flash responds)
    - Menu context injection
    - Client memory injection
    """
    
    def __init__(self, backend_url: str = BACKEND_URL):
        self.backend_url = backend_url
        self.menu_cache: list = []
        self.menu_loaded = False
        self._http_client = httpx.AsyncClient(timeout=LLM_TIMEOUT)
        
    async def load_menu(self) -> list:
        """Fetch menu from backend API."""
        try:
            response = await self._http_client.get(MENU_URL)
            response.raise_for_status()
            data = response.json()
            self.menu_cache = data.get("data", [])
            self.menu_loaded = True
            logger.info(f"Loaded {len(self.menu_cache)} menu items")
            return self.menu_cache
        except Exception as e:
            logger.warning(f"Failed to load menu: {e}")
            return []
    
    async def get_client_memory(self, client_id: str) -> dict:
        """Fetch client memory from backend."""
        try:
            url = f"{self.backend_url}/api/memory/{client_id}"
            response = await self._http_client.get(url)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.debug(f"No memory for client {client_id}: {e}")
            return {}

    async def _save_client_name(self, client_id: str, nombre: str) -> None:
        """Save client name to backend."""
        try:
            response = await self._http_client.post(
                f"{self.backend_url}/api/clientes",
                json={"id": client_id, "nombre": nombre},
                timeout=5.0,
            )
            response.raise_for_status()
            logger.info(f"Client {client_id} name saved: {nombre}")
        except Exception as e:
            logger.warning(f"Could not save client name: {e}")
    
    def check_fast_rule(self, text: str, context: Optional[DialogueContext] = None) -> Optional[PLNResponse]:
        """Check if text matches a fast rule (greeting, farewell, etc.).

        Returns PLNResponse if fast rule matched, None otherwise.
        """
        text_lower = text.lower().strip()
        for rule_name, rule in FAST_RULES.items():
            for keyword in rule["keywords"]:
                if keyword in text_lower:
                    if rule_name == "intro" and rule["response"] == "__CUSTOM_INTRO__":
                        nombre = self._extract_name(text)
                        if nombre:
                            if context is not None:
                                context.client_info["nombre"] = nombre
                            return PLNResponse(
                                text=f"¡Mucho gusto, {nombre}! Ya te tengo registrado. ¿Qué se te provoca hoy?",
                                state=rule["next_state"],
                                is_fast_rule=True,
                            )
                        return None
                    return PLNResponse(
                        text=rule["response"],
                        state=rule["next_state"],
                        is_fast_rule=True,
                    )
        return None

    def _extract_name(self, text: str) -> Optional[str]:
        import re
        patterns = [
            r"me llamo\s+([a-záéíóúñü\s]+?)(?:\s*[,.\?!]|\s+y\s|\s*$|\s+por\s+favor)",
            r"mi nombre es\s+([a-záéíóúñü\s]+?)(?:\s*[,.\?!]|\s+y\s|\s*$|\s+por\s+favor)",
            r"yo soy\s+([a-záéíóúñü\s]+?)(?:\s*[,.\?!]|\s+y\s|\s*$|\s+por\s+favor)",
        ]
        for pat in patterns:
            m = re.search(pat, text.lower().strip())
            if m:
                name = m.group(1).strip().title()
                if name and name not in ("El", "La", "Un", "Una", "De", "Del"):
                    return name
        return None
    
    async def call_llm(self, text: str, context: DialogueContext) -> PLNResponse:
        """Call LLM via backend bridge with fallback chain.
        
        The backend handles the fallback chain:
        DeepSeek V4 Flash → Llama 3.1 8B → Ollama Qwen3.5:9B
        """
        system_prompt = await self._build_system_prompt(context)
        messages = [{"role": "system", "content": system_prompt}]
        for msg in context.history[-10:]:
            messages.append(msg)
        messages.append({"role": "user", "content": text})
        
        try:
            response = await self._http_client.post(
                LLM_BRIDGE_URL,
                json={
                    "message": text,
                    "conversation_id": context.session_id,
                    "model": PRIMARY_LLM,
                    "messages": messages,
                },
                timeout=LLM_TIMEOUT,
            )
            response.raise_for_status()
            data = response.json()
            
            llm_text = data.get("response", data.get("text", ""))
            function_call = data.get("function_call", None)
            
            order_items = []
            should_confirm = False
            if function_call and function_call.get("name") == "registrar_pedido":
                order_items = self._parse_function_call(function_call)
                should_confirm = True
            
            return PLNResponse(
                text=llm_text,
                state=ChipiState.CONFIRMING_ORDER if should_confirm else ChipiState.RESPONDING,
                order_items=order_items,
                is_fast_rule=False,
                should_confirm_order=should_confirm,
                vision_context=context.vision_description,
            )
            
        except httpx.TimeoutException:
            logger.warning(f"LLM timeout after {LLM_TIMEOUT}s")
            return PLNResponse(
                text="Disculpa, me quedé pensando. ¿Podrías repetir?",
                state=ChipiState.LISTENING,
                is_fast_rule=False,
            )
        except Exception as e:
            logger.error(f"LLM call failed: {e}")
            return PLNResponse(
                text="Hubo un problema con mi cerebro. ¿Podrías repetir?",
                state=ChipiState.LISTENING,
                is_fast_rule=False,
            )
    
    async def process_vision(self, image_data: bytes, context: DialogueContext) -> str:
        """Process image through vision pipeline (SEQUENTIAL, NOT fallback).
        
        Step 1: Qwen3 VL 8B describes the image
        Step 2: Description is returned for DeepSeek V4 Flash to use in context
        
        DeepSeek V4 Flash has NO vision capability — it only processes text.
        """
        import base64
        
        if not OPENROUTER_API_KEY:
            logger.warning("No OPENROUTER_API_KEY — skipping vision")
            return ""
        
        try:
            image_b64 = base64.b64encode(image_data).decode("utf-8")
            
            vision_response = await self._http_client.post(
                OPENROUTER_URL,
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": VISION_LLM,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "Describe brevemente lo que ves en esta imagen del cliente. ¿Qué emoción muestra? ¿Hay algo notable? Responde en español, en 2-3 oraciones."},
                                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                            ],
                        }
                    ],
                    "max_tokens": 200,
                },
                timeout=15,
            )
            vision_response.raise_for_status()
            vision_data = vision_response.json()
            
            description = vision_data.get("choices", [{}])[0].get("message", {}).get("content", "")
            logger.info(f"Vision description: {description[:100]}...")
            return description
            
        except Exception as e:
            logger.error(f"Vision pipeline failed: {e}")
            return ""
    
    async def _build_system_prompt(self, context: DialogueContext) -> str:
        """Build system prompt with menu, memory, and vision context."""
        prompt_parts = [
            "Eres Uchino, un robot mesero de una cafetería peruana en UTEC.",
            "Personalidad: amable, energético, con actitud de 'chico de barrio' pero respetuoso.",
            "Usa jerga peruana natural: causa, pata, pe, al toque, chevere, bacán, chévere, de una.",
            "NO exageres la jerga — máximo 1-2 palabras por frase. Sé breve y claro.",
            "Responde en español. Si el cliente habla en otro idioma, responde en español amablemente.",
        ]

        if context.menu_items:
            menu_text = "\n".join(
                f"- {item['nombre']}: S/.{item['precio']} ({item['categoria']})"
                for item in context.menu_items[:20]
            )
            prompt_parts.append(f"\nMenú disponible:\n{menu_text}")

        if context.client_id:
            memory = await self.get_client_memory(context.client_id)
            if memory:
                mem_text = json.dumps(memory, ensure_ascii=False, indent=2)
                prompt_parts.append(f"\nMemoria del cliente:\n{mem_text}")

        if context.client_info:
            prompt_parts.append(f"\nInformación del cliente: {json.dumps(context.client_info, ensure_ascii=False)}")

        if context.mesa:
            prompt_parts.append(f"\nMesa: {context.mesa}")

        if context.vision_description:
            prompt_parts.append(f"\n[Contexto visual]: {context.vision_description}")

        return "\n".join(prompt_parts)
    
    def _parse_function_call(self, function_call: dict) -> list:
        """Parse registrar_pedido function call into OrderItem list."""
        args = function_call.get("arguments", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except json.JSONDecodeError:
                return []
        
        platos = args.get("platos", [])
        items = []
        for plato in platos:
            items.append(OrderItem(
                nombre=plato.get("nombre", ""),
                cantidad=plato.get("cantidad", 1),
                precio=plato.get("precio", 0.0),
                categoria=plato.get("categoria", "plato"),
            ))
        return items
    
    async def process_text(self, text: str, context: DialogueContext) -> PLNResponse:
        """Main entry point: process text through fast rules → LLM.
        
        1. Check fast rules (greeting, farewell, emergency, cancel)
        2. If no fast rule, call LLM via bridge
        3. Return PLNResponse with new state
        """
        fast_response = self.check_fast_rule(text, context)
        if fast_response:
            logger.info(f"Fast rule matched: {fast_response.text[:50]}...")
            if context.client_info.get("nombre") and context.client_id:
                await self._save_client_name(context.client_id, context.client_info["nombre"])
            return fast_response
        if not self.menu_loaded:
            await self.load_menu()
            context.menu_items = self.menu_cache
        context.add_message("user", text)
        response = await self.call_llm(text, context)
        context.add_message("assistant", response.text)
        return response
    
    async def close(self):
        """Close HTTP client."""
        await self._http_client.aclose()
