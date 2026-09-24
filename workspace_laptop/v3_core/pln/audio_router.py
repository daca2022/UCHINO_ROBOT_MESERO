"""
Audio Router — Connects audio_pipeline to the PLN service.

The pipeline (:8001) already connects to WhisperLiveKit (:8002).
The PLN only needs to connect to the pipeline, which forwards:
- Wake word events
- Transcription results (from STT)
- Emotion detection
"""

import asyncio
import json
import logging
from typing import Optional, Callable, Awaitable

import websockets

from .types import ChipiState
from .config import PIPELINE_URL, WAKE_WORD
from .states import can_transition

logger = logging.getLogger(__name__)


class AudioRouter:
    """Manages audio pipeline connection: wake word + transcription.
    
    Connects ONLY to audio_pipeline (:8001).
    The pipeline handles the connection to WhisperLiveKit (:8002).
    """
    
    def __init__(
        self,
        on_wake_word: Optional[Callable[[], Awaitable[None]]] = None,
        on_transcription: Optional[Callable[[str], Awaitable[None]]] = None,
    ):
        self.state = ChipiState.SLEEP
        self.on_wake_word = on_wake_word
        self.on_transcription = on_transcription
        self.pipeline_ws = None
        self._running = False
        self._last_transcription = ""
        
    async def start(self) -> None:
        """Start audio routing — connect to pipeline."""
        self._running = True
        logger.info("AudioRouter starting — connecting to pipeline")
        try:
            await self._connect_pipeline()
        except Exception as e:
            logger.error(f"AudioRouter start failed: {e}")
            self._running = False
            
    async def stop(self) -> None:
        """Stop audio routing — close connection."""
        self._running = False
        if self.pipeline_ws:
            await self.pipeline_ws.close()
        logger.info("AudioRouter stopped")
    
    async def _connect_pipeline(self) -> None:
        """Connect to audio_pipeline WebSocket."""
        uri = f"{PIPELINE_URL}/asr"
        try:
            async with websockets.connect(uri) as ws:
                self.pipeline_ws = ws
                logger.info(f"Connected to audio_pipeline at {PIPELINE_URL}")
                async for message in ws:
                    if not self._running:
                        break
                    await self._handle_message(message)
        except ConnectionRefusedError:
            logger.warning(f"Pipeline at {PIPELINE_URL} not available — running in standalone mode")
        except Exception as e:
            logger.error(f"Pipeline connection error: {e}")
    
    async def _handle_message(self, message: str) -> None:
        """Handle messages from pipeline (includes STT transcriptions)."""
        try:
            data = json.loads(message)
            msg_type = data.get("type", "")
            
            # Wake word detection
            if msg_type == "wake_word":
                keyword = data.get("keyword", "").lower()
                if WAKE_WORD in keyword or keyword in WAKE_WORD:
                    logger.info(f"Wake word detected: {keyword}")
                    if can_transition(self.state, ChipiState.AWAKE):
                        self.state = ChipiState.AWAKE
                        if self.on_wake_word:
                            await self.on_wake_word()
                            
            # Transcription from STT (forwarded by pipeline)
            elif msg_type == "transcript":
                text = data.get("text", "").strip()
                if text and self.state in (ChipiState.AWAKE, ChipiState.LISTENING):
                    logger.info(f"Transcription: {text}")
                    if can_transition(self.state, ChipiState.THINKING):
                        self.state = ChipiState.THINKING
                    if self.on_transcription:
                        await self.on_transcription(text)
                        
            # Alternative format from WhisperLiveKit
            elif "text" in data and data.get("is_final", False):
                text = data.get("text", "").strip()
                if text and self.state in (ChipiState.AWAKE, ChipiState.LISTENING):
                    logger.info(f"Transcription (final): {text}")
                    if can_transition(self.state, ChipiState.THINKING):
                        self.state = ChipiState.THINKING
                    if self.on_transcription:
                        await self.on_transcription(text)
                        
            # Emotion detection
            elif msg_type == "emotion":
                emotion = data.get("emotion", "neutral")
                logger.debug(f"Emotion: {emotion}")
                
        except json.JSONDecodeError:
            logger.warning(f"Non-JSON message: {message[:100]}")
        except Exception as e:
            logger.error(f"Error handling message: {e}")
    
    def set_state(self, new_state: ChipiState) -> bool:
        """Manually set state (for external state transitions)."""
        if can_transition(self.state, new_state):
            self.state = new_state
            return True
        return False
    
    @property
    def is_listening(self) -> bool:
        """Whether the router is actively listening for voice input."""
        return self.state in (ChipiState.AWAKE, ChipiState.LISTENING)
