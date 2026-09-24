import asyncio
import os
from typing import Optional, Dict, Any, List
import httpx


def _default_llm_bridge_url() -> str:
    """Deriva la URL del bridge LLM desde la variable de entorno PORT,
    con fallback al puerto v3 activo."""
    port = os.environ.get("PORT", "3005")
    return f"http://localhost:{port}/api/llm"


class LlmClient:
    """HTTP client for communicating with the Node.js LLM orchestrator bridge."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        timeout: int = 30,
        max_retries: int = 1,
    ):
        self.base_url = base_url or _default_llm_bridge_url()
        self.timeout = timeout
        self.max_retries = max_retries
        self.internal_token = os.environ.get("LLM_BRIDGE_TOKEN") or os.environ.get("JWT_SECRET") or os.environ.get("ADMIN_JWT_SECRET")

    async def send_message(
        self,
        text: str,
        history: Optional[List[Dict[str, str]]] = None,
        provider: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"message": text}
        if history:
            payload["history"] = history
        if provider:
            payload["provider"] = provider

        response = await self._post("/chat", payload)
        return {
            "text": response.get("text", ""),
            "functionCalls": response.get("functionCalls", []),
            "provider": response.get("provider", "unknown"),
        }

    async def send_dialogue(
        self,
        state: str,
        input_text: str,
        session_id: Optional[str] = None,
        mesa: Optional[str] = None,
        client_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {"state": state, "input": input_text}
        if session_id:
            payload["sessionId"] = session_id
        if mesa:
            payload["mesa"] = mesa
        if client_id:
            payload["clientId"] = client_id

        response = await self._post("/dialogue", payload)
        return {
            "response": response.get("response", response.get("text", "")),
            "newState": response.get("newState", state),
            "emotion": response.get("emotion", "neutral"),
            "functionCalls": response.get("functionCalls", []),
        }

    async def handle_function_call(self, call: Dict[str, Any]) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "name": call.get("name"),
            "args": call.get("args", {}),
        }
        if "sessionId" in call:
            payload["sessionId"] = call["sessionId"]

        response = await self._post("/function-call", payload)
        return {
            "success": response.get("success", False),
            "result": response.get("result"),
            "name": call.get("name"),
        }

    async def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.base_url.rstrip('/')}{path}"

        for attempt in range(self.max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as session:
                    headers = {}
                    if path in {"/chat", "/dialogue", "/function-call"} and self.internal_token:
                        headers["X-Internal-Token"] = self.internal_token
                    resp = await session.post(url, json=payload, headers=headers)
                    if resp.status_code == 200:
                        return resp.json()
                    if resp.status_code == 429:
                        if attempt < self.max_retries:
                            await asyncio.sleep(1 * (attempt + 1))
                            continue
                        raise Exception(f"Rate limited (429): {resp.text}")
                    raise Exception(f"HTTP {resp.status_code}: {resp.text}")
            except httpx.ConnectError as e:
                if attempt < self.max_retries:
                    await asyncio.sleep(1 * (attempt + 1))
                    continue
                raise ConnectionError(
                    f"No se pudo conectar al servidor LLM en {url}. "
                    f"Verifica que backend_api esté corriendo (puerto 3005)."
                ) from e
            except asyncio.TimeoutError:
                if attempt < self.max_retries:
                    await asyncio.sleep(1 * (attempt + 1))
                    continue
                raise TimeoutError(f"Timeout ({self.timeout}s) conectando a {url}")

        raise Exception(f"All {self.max_retries + 1} attempts failed for {url}")
