import asyncio
from typing import Dict, Any
import httpx


class Ros2Bridge:
    def __init__(self, base_url: str = "http://localhost:3005", timeout: float = 10.0, logger=None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.logger = logger or print

    async def go_to(self, destino: str) -> Dict[str, Any]:
        return await self._post("/api/robot/estado", {"destino": destino})

    async def get_state(self) -> Dict[str, Any]:
        return await self._get("/api/robot/estado")

    async def iniciar_recorrido(self, pedido_id: str, mesa: str) -> Dict[str, Any]:
        return await self._post("/api/recorrido/iniciar", {"pedidoId": pedido_id, "mesa": mesa})

    async def obtener_estado_recorrido(self) -> Dict[str, Any]:
        return await self._get("/api/recorrido/estado")

    async def stop(self) -> Dict[str, Any]:
        return await self._post("/api/robot/estado", {"command": "stop"})

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
            self.logger(f"[Ros2Bridge] GET {path} error: {exc}")
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
            self.logger(f"[Ros2Bridge] POST {path} error: {exc}")
            return {"success": False, "error": str(exc)}
