"""
PLN Configuration — Environment variables and constants.

All service URLs, timeouts, and LLM provider settings read from
v3_core/.env with sensible defaults. DeepSeek V4 Flash is the
primary text LLM; Qwen3 VL 8B is the VISION model (describes images
for DeepSeek to process). They work in a SEQUENTIAL pipeline, NOT
as fallbacks.
"""

import os

# ── Wake word ──────────────────────────────────────────────
WAKE_WORD = os.getenv("WAKE_WORD", "uchino")

# ── Service URLs (from .env with defaults) ──────────────────
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3005")
STT_URL = os.getenv("WLK_URL", "ws://localhost:8002")
PIPELINE_URL = os.getenv("PIPELINE_URL", "ws://localhost:8001")
ORCHESTRATOR_URL = os.getenv("ORCHESTRATOR_URL", "http://localhost:8100")
TTS_URL = os.getenv("TTS_URL", "http://localhost:3005/api/tts/speak")
LLM_BRIDGE_URL = os.getenv("LLM_BRIDGE_URL", "http://localhost:3005/api/llm/chat")
MENU_URL = f"{BACKEND_URL}/api/menu"
PEDIDOS_URL = f"{BACKEND_URL}/api/pedidos"

# ── LLM Provider Chain (text) ──────────────────────────────
PRIMARY_LLM = os.getenv("OPENROUTER_MODEL", "deepseek/deepseek-v4-flash")
FALLBACK_LLM = os.getenv("OPENROUTER_FALLBACK_MODEL", "meta-llama/llama-3.1-8b-instruct")
OFFLINE_LLM = os.getenv("OLLAMA_MODEL", "qwen3.5:9b")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_URL = os.getenv("OPENROUTER_URL", "https://openrouter.ai/api/v1/chat/completions")

# ── Vision Pipeline (SEQUENTIAL, NOT fallback) ──────────────
# Qwen3 VL 8B describes image → description → DeepSeek V4 Flash responds
# DeepSeek V4 Flash has NO vision capability — it's text-only
VISION_LLM = os.getenv("OPENROUTER_VISION_MODEL", "qwen/qwen3-vl-8b-instruct")
# The text LLM that receives the vision description is PRIMARY_LLM (DeepSeek V4 Flash)

# ── Timeouts (seconds) ─────────────────────────────────────
STT_TIMEOUT = int(os.getenv("STT_TIMEOUT", "10"))
LLM_TIMEOUT = int(os.getenv("LLM_TIMEOUT", "15"))
TTS_TIMEOUT = int(os.getenv("TTS_TIMEOUT", "10"))
LATENCY_BUDGET = 5.0  # Target end-to-end seconds

# ── Audio settings ──────────────────────────────────────────
SAMPLE_RATE = 16000
CHANNELS = 1
CHUNK_SIZE = 4096

# ── State timeouts (seconds) ──────────────────────────────
STATE_TIMEOUTS = {
    "SLEEP": None,           # No timeout — listens forever
    "AWAKE": 10,             # 10s to start talking
    "LISTENING": 15,         # 15s to finish talking
    "THINKING": 15,          # 15s for LLM response
    "RESPONDING": 10,        # 10s for TTS
    "CONFIRMING_ORDER": 30,  # 30s to confirm order
    "DELIVERING": 5,         # 5s to send to backend
}
