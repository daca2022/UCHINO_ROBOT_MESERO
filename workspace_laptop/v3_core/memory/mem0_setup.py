#!/usr/bin/env python3
"""
mem0_setup.py — Mem0 Self-Hosted Configuration
================================================
Configures Mem0 with:
  - Vector store: ChromaDB (localhost:8000, existing Docker container)
  - LLM: Qwen 3.5 Flash via OpenRouter (cheap, fast)
  - Embedder: sentence-transformers local (free, CPU, ~50ms)
  - History DB: SQLite (local, no cloud)

No Gemini, no cloud embeddings, no API costs for embeddings.

Usage:
    from v3_core.memory.mem0_setup import get_memory
    memory = get_memory()
"""

import os
from pathlib import Path
from mem0 import Memory

# ── Environment ───────────────────────────────────────────────────
_MEM0_DIR = Path(os.environ.get("MEM0_HISTORY_DIR", str(Path.home() / ".mem0")))
_MEM0_DIR.mkdir(parents=True, exist_ok=True)

CHROMA_HOST = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8000"))

# ── OpenRouter (Qwen) LLM ─────────────────────────────────────────
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL",
                                      "https://openrouter.ai/api/v1")
OPENROUTER_MODEL = os.environ.get("OPENROUTER_MODEL",
                                  "deepseek/deepseek-v4-flash")

# ── Local Embedding Model ─────────────────────────────────────────
# Multilingual sentence-transformer model for Spanish + other languages.
# paraphrase-multilingual-MiniLM-L12-v2 (250MB) balances quality vs speed.
# Falls back to all-MiniLM-L6-v2 if not specified.
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL",
                                 "paraphrase-multilingual-MiniLM-L12-v2")

# ── Mem0 Configuration ────────────────────────────────────────────
_MEM0_CONFIG = {
    "vector_store": {
        "provider": "chroma",
        "config": {
            "collection_name": "mem0_memory",
            "host": CHROMA_HOST,
            "port": CHROMA_PORT,
        },
    },
    "llm": {
        "provider": "openai",  # OpenRouter is OpenAI-compatible
        "config": {
            "model": OPENROUTER_MODEL,
            "api_key": OPENROUTER_API_KEY,
            "openai_base_url": OPENROUTER_BASE_URL,
            "temperature": 0.1,
        },
    },
    "embedder": {
        "provider": "huggingface",
        "config": {
            "model": EMBEDDING_MODEL,
        },
    },
    "history_db_path": str(_MEM0_DIR / "history.db"),
    "version": "v1.1",
}

# ── Singleton ──────────────────────────────────────────────────────
_memory_instance: Memory | None = None


def get_memory() -> Memory:
    """Get or create the Mem0 Memory singleton."""
    global _memory_instance
    if _memory_instance is None:
        _memory_instance = Memory.from_config(_MEM0_CONFIG)
        print(f"[mem0_setup] Mem0 initialized → ChromaDB {CHROMA_HOST}:{CHROMA_PORT}"
              f" | LLM: {OPENROUTER_MODEL} | embedder: {EMBEDDING_MODEL}")
    return _memory_instance


def get_config() -> dict:
    """Return the Mem0 configuration dict (for inspection)."""
    return dict(_MEM0_CONFIG)


async def get_async_memory() -> Memory:
    return get_memory()


def test_connection() -> bool:
    """Verify ChromaDB is reachable."""
    try:
        import chromadb
        client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
        client.heartbeat()
        return True
    except Exception:
        return False
