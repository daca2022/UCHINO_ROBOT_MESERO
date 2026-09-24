import asyncio
from typing import Dict, Any
import httpx


class VisionClient:
    def __init__(self, base_url: str = "http://localhost:3005", timeout: float = 8.0, logger=None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.logger = logger or print

    async def query(self, prompt: str, frame_source: str = "rgb") -> Dict[str, Any]:
        return await self._post("/api/vision/query", {"prompt": prompt, "frame_source": frame_source})

    async def capture(self) -> Dict[str, Any]:
        return await self._get("/api/vision/capture")

    async def stats(self) -> Dict[str, Any]:
        return await self._get("/api/vision/stats")

    async def verify_action(self, action: str, expected_result: str) -> Dict[str, Any]:
        verification_prompts = {
            "entregar_pedido": "Verifica si el robot ha entregado correctamente el pedido en la mesa. ¿Hay platos o bebidas entregados? Responde con SÍ o NO y una breve explicación.",
            "ir_a_mesa": "Verifica si el robot está cerca de una mesa con clientes. Responde con SÍ o NO.",
            "ir_a_cocina": "Verifica si el robot está en la cocina o cerca de ella. Responde con SÍ o NO.",
            "recoger_pedido": "Verifica si el robot ha recogido el pedido de la cocina. Responde con SÍ o NO.",
            "default": f"Verifica si la acción '{action}' se completó correctamente. Responde con SÍ o NO y una breve explicación.",
        }
        prompt = verification_prompts.get(action, verification_prompts["default"])
        result = await self.query(prompt)
        text = result.get("description", "").lower()
        success = "sí" in text or "si" in text or "correcto" in text or "entregado" in text or "cerca" in text
        return {
            "success": success,
            "action": action,
            "expected": expected_result,
            "vision_description": result.get("description"),
            "raw": result,
        }

    async def _get(self, path: str) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.get(url)
                if resp.status_code == 200:
                    return resp.json()
                return {"success": False, "error": f"HTTP {resp.status_code}"}
        except asyncio.TimeoutError:
            return {"success": False, "error": "timeout"}
        except Exception as exc:
            self.logger(f"[VisionClient] GET {path} error: {exc}")
            return {"success": False, "error": str(exc)}

    async def _post(self, path: str, payload: Dict) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(url, json=payload)
                if resp.status_code in (200, 201):
                    return resp.json()
                return {"success": False, "error": f"HTTP {resp.status_code}"}
        except asyncio.TimeoutError:
            return {"success": False, "error": "timeout"}
        except Exception as exc:
            self.logger(f"[VisionClient] POST {path} error: {exc}")
            return {"success": False, "error": str(exc)}
