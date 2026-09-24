"""
WebSocket Client — Sends orders to backend and receives real-time updates.

Connects to:
- REST API at :3005 for order creation (POST /api/pedidos)
- WebSocket at :3005/ws/ui for real-time updates (nuevo_pedido, pedido_actualizado)
"""

import asyncio
import json
import logging
from typing import Optional, Callable

import httpx
import websockets

from .config import BACKEND_URL, PEDIDOS_URL

logger = logging.getLogger(__name__)


class WSClient:
    """WebSocket client for backend communication.
    
    Handles:
    - Sending orders via REST POST /api/pedidos with modo="voz"
    - Receiving real-time updates via WebSocket /ws/ui
    - Auto-reconnection with exponential backoff
    """
    
    def __init__(self, backend_url: str = BACKEND_URL):
        self.backend_url = backend_url
        self.ws_url = backend_url.replace("http", "ws") + "/ws/ui"
        self._http_client = httpx.AsyncClient(timeout=10.0)
        self._ws = None
        self._running = False
        self._reconnect_delay = 1.0
        self._max_reconnect_delay = 30.0
        self._on_pedido_nuevo: Optional[Callable] = None
        self._on_pedido_actualizado: Optional[Callable] = None
    
    def on_pedido_nuevo(self, callback: Callable):
        """Register callback for new order notifications."""
        self._on_pedido_nuevo = callback
    
    def on_pedido_actualizado(self, callback: Callable):
        """Register callback for order update notifications."""
        self._on_pedido_actualizado = callback
    
    async def send_order(self, order: dict) -> dict:
        """Send order to backend via POST /api/pedidos.
        
        Order format: {mesa, platos: [{nombre, cantidad, precio, categoria}], total, modo: "voz"}
        Returns the created order from the backend.
        """
        # Ensure modo is set
        if "modo" not in order:
            order["modo"] = "voz"
        
        # Remove internal fields
        clean_order = {k: v for k, v in order.items() if k not in ("warnings",)}
        
        try:
            response = await self._http_client.post(
                PEDIDOS_URL,
                json=clean_order,
                timeout=10.0,
            )
            response.raise_for_status()
            result = response.json()
            logger.info(f"Order created: mesa={clean_order.get('mesa')}, modo={clean_order.get('modo')}")
            return result
        except httpx.HTTPStatusError as e:
            logger.error(f"Order creation failed: {e.response.status_code} {e.response.text}")
            return {"error": f"HTTP {e.response.status_code}", "detail": e.response.text}
        except Exception as e:
            logger.error(f"Order creation failed: {e}")
            return {"error": str(e)}
    
    async def connect_ws(self) -> None:
        """Connect to WebSocket for real-time updates with auto-reconnect."""
        self._running = True
        while self._running:
            try:
                async with websockets.connect(self.ws_url) as ws:
                    self._ws = ws
                    self._reconnect_delay = 1.0  # Reset on successful connection
                    logger.info(f"Connected to WebSocket: {self.ws_url}")
                    
                    async for message in ws:
                        if not self._running:
                            break
                        await self._handle_message(message)
                        
            except ConnectionRefusedError:
                logger.warning(f"WebSocket at {self.ws_url} not available — retrying in {self._reconnect_delay:.0f}s")
            except websockets.exceptions.ConnectionClosed:
                logger.warning("WebSocket connection closed — reconnecting")
            except Exception as e:
                logger.error(f"WebSocket error: {e}")
            
            if self._running:
                await asyncio.sleep(self._reconnect_delay)
                self._reconnect_delay = min(self._reconnect_delay * 2, self._max_reconnect_delay)
    
    async def _handle_message(self, message: str) -> None:
        """Handle incoming WebSocket messages from backend."""
        try:
            data = json.loads(message)
            msg_type = data.get("type", "")
            
            if msg_type == "nuevo_pedido":
                logger.info(f"New order notification: {data.get('pedido', {}).get('id')}")
                if self._on_pedido_nuevo:
                    await self._on_pedido_nuevo(data.get("pedido", {}))
                    
            elif msg_type == "pedido_actualizado":
                logger.info(f"Order update: {data.get('pedido', {}).get('id')}")
                if self._on_pedido_actualizado:
                    await self._on_pedido_actualizado(data.get("pedido", {}))
                    
        except json.JSONDecodeError:
            logger.warning(f"Non-JSON WebSocket message: {message[:100]}")
        except Exception as e:
            logger.error(f"Error handling WebSocket message: {e}")
    
    async def disconnect(self) -> None:
        """Disconnect from WebSocket."""
        self._running = False
        if self._ws:
            await self._ws.close()
        await self._http_client.aclose()
        logger.info("WSClient disconnected")
