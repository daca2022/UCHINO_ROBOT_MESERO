"""
PLN Main Service — Continuous voice pipeline orchestrator.

Entry point: python -m pln.main

Orchestrates the full voice pipeline:
    SLEEP → (wake word) → AWAKE → (listening) → LISTENING →
    THINKING → (LLM response) → RESPONDING → (order?) → 
    CONFIRMING_ORDER → DELIVERING → LISTENING/SLEEP
"""

import asyncio
import logging
import signal
import uuid

from .types import ChipiState, DialogueContext, PLNResponse
from .config import TTS_URL, STATE_TIMEOUTS
from .states import can_transition
from .audio_router import AudioRouter
from .dialogue_integrator import DialogueIntegrator
from .order_extractor import OrderExtractor
from .ws_client import WSClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("pln.main")


class ChipiPLN:
    """Main PLN orchestrator — runs the continuous voice pipeline.
    
    State machine:
        SLEEP → AWAKE → LISTENING → THINKING → RESPONDING →
        CONFIRMING_ORDER → DELIVERING → (LISTENING or SLEEP)
    
    Each state has a timeout (from STATE_TIMEOUTS). On timeout,
    the service falls back to SLEEP (safe default).
    """
    
    def __init__(self):
        self.state = ChipiState.SLEEP
        self.context = DialogueContext(session_id=str(uuid.uuid4())[:8])
        self.audio_router = AudioRouter(
            on_wake_word=self._on_wake_word,
            on_transcription=self._on_transcription,
        )
        self.dialogue = DialogueIntegrator()
        self.order_extractor = OrderExtractor()
        self.ws_client = WSClient()
        self._running = False
        self._state_timers = {}
        logger.info(f"ChipiPLN initialized, session={self.context.session_id}")
    
    async def start(self) -> None:
        """Start the PLN service — connect to all services and begin listening."""
        self._running = True
        logger.info("ChipiPLN starting — entering SLEEP state")
        
        # Load menu for order extraction
        await self.order_extractor.load_menu()
        logger.info(f"Menu loaded: {len(self.order_extractor.menu_cache)} items")
        
        # Start all services concurrently
        try:
            await asyncio.gather(
                self.audio_router.start(),
                self.ws_client.connect_ws(),
                self._state_loop(),
            )
        except asyncio.CancelledError:
            logger.info("ChipiPLN cancelled — shutting down")
        except Exception as e:
            logger.error(f"ChipiPLN error: {e}")
        finally:
            await self.stop()
    
    async def stop(self) -> None:
        """Stop the PLN service — close all connections."""
        self._running = False
        await self.audio_router.stop()
        await self.dialogue.close()
        await self.order_extractor.close()
        await self.ws_client.disconnect()
        logger.info("ChipiPLN stopped")
    
    async def _state_loop(self) -> None:
        """Main state machine loop — processes state transitions and timeouts."""
        while self._running:
            await asyncio.sleep(0.1)  # 100ms tick
            
            timeout = STATE_TIMEOUTS.get(self.state.name)
            if timeout is not None:
                pass
    
    async def _on_wake_word(self) -> None:
        """Called by AudioRouter when wake word is detected."""
        logger.info("Wake word detected — transitioning to AWAKE")
        if can_transition(self.state, ChipiState.AWAKE):
            self.state = ChipiState.AWAKE
            self.context.state = ChipiState.AWAKE
            # Reset context for new interaction
            self.context.session_id = str(uuid.uuid4())[:8]
            self.context.clear_order()
            self.context.history = []
            
            # Send greeting
            response = PLNResponse(
                text="¡Hola causa! ¿Qué te provoca hoy?",
                state=ChipiState.LISTENING,
                is_fast_rule=True,
            )
            await self._handle_response(response)
    
    async def _on_transcription(self, text: str) -> None:
        """Called by AudioRouter when transcription is complete."""
        logger.info(f"Transcription received: {text[:50]}...")
        self.context.raw_transcription = text
        
        if can_transition(self.state, ChipiState.THINKING):
            self.state = ChipiState.THINKING
            self.context.state = ChipiState.THINKING
        
        response = await self.dialogue.process_text(text, self.context)
        await self._handle_response(response)
    
    async def _handle_response(self, response: PLNResponse) -> None:
        """Handle a PLNResponse — speak it, extract orders, or confirm."""
        if can_transition(self.state, response.state):
            self.state = response.state
            self.context.state = response.state
        
        if response.order_items:
            for item in response.order_items:
                self.context.add_to_order(item)
            logger.info(f"Order items detected: {[i.nombre for i in response.order_items]}")
        
        if response.should_confirm_order and self.context.current_order:
            await self._confirm_and_send_order()
        
        if response.text:
            await self._speak(response.text)
        
        if self.state == ChipiState.SLEEP:
            self.context.clear_order()
    
    async def _confirm_and_send_order(self) -> None:
        """Confirm order with user and send to backend."""
        if can_transition(self.state, ChipiState.CONFIRMING_ORDER):
            self.state = ChipiState.CONFIRMING_ORDER
            self.context.state = ChipiState.CONFIRMING_ORDER
        
        order = self.context.get_order_payload(modo="voz")
        validated_order = await self._validate_order(order)
        
        if can_transition(self.state, ChipiState.DELIVERING):
            self.state = ChipiState.DELIVERING
            self.context.state = ChipiState.DELIVERING
            
            result = await self.ws_client.send_order(validated_order)
            
            if "error" not in result:
                logger.info(f"Order delivered: {result.get('id', 'unknown')}")
                await self._speak("¡Listo causa! Tu pedido ya está en camino.")
            else:
                logger.error(f"Order failed: {result}")
                await self._speak("Hubo un problema con el pedido. ¿Podrías repetir?")
        
        if can_transition(self.state, ChipiState.LISTENING):
            self.state = ChipiState.LISTENING
            self.context.state = ChipiState.LISTENING
    
    async def _validate_order(self, order: dict) -> dict:
        """Validate order items against menu and fix prices."""
        validated_platos = []
        for plato in order.get("platos", []):
            menu_item = self.order_extractor._find_menu_item(plato["nombre"])
            if menu_item:
                validated_platos.append({
                    "nombre": menu_item["nombre"],
                    "cantidad": plato["cantidad"],
                    "precio": menu_item["precio"],
                    "categoria": menu_item.get("categoria", "plato"),
                })
            else:
                validated_platos.append(plato)  # Keep as-is if not found
        
        total = sum(p["precio"] * p["cantidad"] for p in validated_platos)
        
        return {
            "mesa": order.get("mesa", "M1"),
            "platos": validated_platos,
            "total": total,
            "modo": "voz",
        }
    
    async def _speak(self, text: str) -> None:
        """Send text to TTS via backend (Piper or Kokoro). Returns metadata."""
        try:
            import httpx
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(
                    TTS_URL,
                    json={"text": text},
                )
                if response.status_code == 200:
                    engine = response.headers.get("x-tts-engine", "unknown")
                    duration = response.headers.get("x-tts-duration", "0")
                    logger.info(f"TTS OK: engine={engine}, duration={duration}s, text='{text[:50]}...'")
                else:
                    logger.warning(f"TTS failed: {response.status_code}")
        except Exception as e:
            logger.warning(f"TTS unavailable: {e}")
    
    async def _process_vision(self, image_data: bytes) -> None:
        """Process image through vision pipeline (Qwen3 VL 8B → DeepSeek V4 Flash)."""
        description = await self.dialogue.process_vision(image_data, self.context)
        if description:
            self.context.vision_description = description
            logger.info(f"Vision context updated: {description[:80]}...")


async def main():
    """Entry point for python -m pln.main."""
    pln = ChipiPLN()
    
    # Handle Ctrl+C gracefully
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(pln.stop()))
    
    try:
        await pln.start()
    except KeyboardInterrupt:
        logger.info("KeyboardInterrupt — shutting down")
    finally:
        await pln.stop()


if __name__ == "__main__":
    asyncio.run(main())
