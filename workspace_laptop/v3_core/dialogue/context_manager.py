"""
Context Window Manager — Manages conversation history size.
After 20 raw turns, summarizes older turns and keeps last 10 + summary.
"""

from typing import List, Dict, Optional
import os
import asyncio
import concurrent.futures

from .llm_client import LlmClient


class ContextWindowManager:
    """
    Prevents context overflow by summarizing conversation history.

    Strategy:
        - Keep up to MAX_RAW_TURNS (20) raw messages
        - When exceeded, summarize oldest messages
        - Retain: last KEEP_RAW (10) raw messages + summary prefix
    """

    MAX_RAW_TURNS = 20
    KEEP_RAW = 10
    SUMMARIZE_CHUNK = 10  # summarize in chunks of this many messages at a time

    def __init__(self, api_key: Optional[str] = None, model: str = "deepseek/deepseek-v4-flash"):
        self.api_key = api_key or os.getenv("OPENROUTER_API_KEY")
        self.model_name = model
        self._llm_client = LlmClient()

    def manage(self, messages: List[Dict], existing_summary: Optional[str] = None) -> tuple[List[Dict], Optional[str]]:
        """
        Ensure messages fit within context window.

        Args:
            messages: List of {"role": "user"|"assistant", "content": "..."}
            existing_summary: Previous summary string or None

        Returns:
            (managed_messages, new_summary) — managed_messages fits within limits
        """
        if len(messages) <= self.MAX_RAW_TURNS:
            return messages, existing_summary

        # We have too many messages. Summarize the oldest.
        overflow_count = len(messages) - self.KEEP_RAW
        to_summarize = messages[:overflow_count]
        kept = messages[overflow_count:]

        summary = self._summarize_conversation(to_summarize, existing_summary)

        # Build managed messages with summary as system context
        managed = kept  # the raw messages we keep

        return managed, summary

    def build_system_context(self, summary: Optional[str]) -> str:
        """Build a system context string that includes the summary."""
        if summary:
            return f"[Resumen de la conversación anterior]\n{summary}\n[/Resumen]"
        return ""

    def _summarize_conversation(self, messages: List[Dict], existing_summary: Optional[str] = None) -> str:
        """Summarize a chunk of conversation using the LLM bridge."""
        conversation_text = "\n".join(
            f"{'Usuario' if m['role'] == 'user' else 'Uchino'}: {m['content']}"
            for m in messages
        )

        existing_context = f"Resumen previo:\n{existing_summary}\n\n" if existing_summary else ""

        prompt = (
            f"Eres Uchino, un robot mesero. Resume la siguiente conversación en español en 2-3 oraciones. "
            f"Incluye solo información relevante: pedidos mencionados, preferencias del cliente, "
            f"y el estado actual de la interacción.\n\n"
            f"{existing_context}"
            f"Conversación a resumir:\n{conversation_text}\n\n"
            f"Resumen:"
        )

        try:
            def _run_async():
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    return loop.run_until_complete(self._llm_client.send_message(text=prompt))
                finally:
                    loop.close()

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(_run_async)
                response = future.result(timeout=30)

            return response.get("text", "").strip()
        except Exception:
            return self._fallback_summary(messages)

    def _fallback_summary(self, messages: List[Dict]) -> str:
        """Simple keyword-based fallback summary without LLM."""
        all_text = " ".join(m.get("content", "") for m in messages).lower()
        parts = []

        if any(word in all_text for word in ["pedir", "pedido", "orden", "quisiera", "dame"]):
            parts.append("El cliente mostró interés en hacer un pedido.")

        if any(word in all_text for word in ["menú", "menu", "carta"]):
            parts.append("El cliente preguntó por el menú.")

        if any(word in all_text for word in ["confirmar", "confirmo", "sí", "correcto"]):
            parts.append("El cliente confirmó información.")

        if any(word in all_text for word in ["cancelar", "cancel", "no"]):
            parts.append("El cliente canceló o rechazó algo.")

        if not parts:
            parts.append("Conversación general entre Chipi y el cliente.")

        return " ".join(parts)
