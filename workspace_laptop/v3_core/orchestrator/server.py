#!/usr/bin/env python3
"""
orchestrator/server.py — FastAPI sidecar para MasterOrchestrator.

Expone endpoint POST /orchestrate para que el backend Node.js envíe
texto transcrito (ASR) y reciba respuesta con TTS + acciones.

Uso (desde chipi_workspace_pln/):
    uvicorn v3_core.orchestrator.server:app --host 0.0.0.0 --port 8100
"""

import os
import sys
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional, Dict, Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# ── Path setup ────────────────────────────────────────────────────
# Asegura que v3_core sea importable como paquete
_V3_ROOT = Path(__file__).resolve().parents[1]  # v3_core/
_V3_PARENT = _V3_ROOT.parent  # chipi_workspace_pln/
if str(_V3_PARENT) not in sys.path:
    sys.path.insert(0, str(_V3_PARENT))

# ── Environment ────────────────────────────────────────────────────
_ENV_PATH = _V3_ROOT / ".env"
if _ENV_PATH.exists():
    with open(_ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip("'\"")
            if not os.environ.get(key):
                os.environ.setdefault(key, val)

# ── Imports (after path + env are ready) ──────────────────────────
from v3_core.orchestrator import MasterOrchestrator

# ── Logging ────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
logger = logging.getLogger("orchestrator-server")

# ── Models ─────────────────────────────────────────────────────────


class OrchestrateRequest(BaseModel):
    """Payload para POST /orchestrate."""
    text: str
    session_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


# ── Global orchestrator instance ──────────────────────────────────
_orchestrator: Optional[MasterOrchestrator] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Inicializa y cierra el MasterOrchestrator."""
    global _orchestrator
    logger.info("=" * 50)
    logger.info("Iniciando MasterOrchestrator sidecar...")
    logger.info(f"V3_ROOT: {_V3_ROOT}")
    logger.info(f"OPENROUTER_API_KEY presente: {bool(os.environ.get('OPENROUTER_API_KEY'))}")
    logger.info(f"OPENROUTER_MODEL: {os.environ.get('OPENROUTER_MODEL', 'deepseek/deepseek-v4-flash')}")

    backend_url = os.environ.get("BACKEND_URL", "http://localhost:3005")

    _orchestrator = MasterOrchestrator(
        backend_url=backend_url,
        enable_vision_verify=False,  # desactivado por defecto en sidecar
    )

    if _orchestrator.dialogue:
        logger.info("  ✅ Dialogue (LangGraph) — iniciado")
    else:
        logger.warning("  ⚠️  Dialogue — NO disponible")

    if _orchestrator.memory:
        logger.info("  ✅ Memory (Mem0) — iniciado")
    else:
        logger.warning("  ⚠️  Memory — NO disponible")

    if _orchestrator.person_memory:
        logger.info("  ✅ PersonMemory — iniciado")
    else:
        logger.warning("  ⚠️  PersonMemory — NO disponible")

    if _orchestrator.tts:
        logger.info("  ✅ TTS (Kokoro → Piper fallback) — iniciado")
    else:
        logger.warning("  ⚠️  TTS — NO disponible")

    logger.info("MasterOrchestrator listo")
    logger.info("=" * 50)
    yield

    # Shutdown
    if _orchestrator:
        logger.info("Deteniendo MasterOrchestrator...")
        await _orchestrator.shutdown()
        logger.info("MasterOrchestrator detenido")


app = FastAPI(
    title="Uchino Orchestrator API",
    version="1.0.0",
    description="Sidecar Python para el orquestador de Uchino Robot Mesero",
    lifespan=lifespan,
)


# ── Endpoints ──────────────────────────────────────────────────────


@app.post("/orchestrate")
async def orchestrate(req: OrchestrateRequest):
    global _orchestrator
    if not _orchestrator:
        raise HTTPException(status_code=503, detail="Orchestrator no inicializado")

    metadata = req.metadata or {}
    if req.session_id:
        metadata["session_id"] = req.session_id

    logger.info(f"[{req.session_id or '?'}] → {req.text[:80]}")

    try:
        result = await _orchestrator.process_input("text", req.text, metadata)
    except Exception as exc:
        logger.error(f"[{req.session_id or '?'}] Error: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(exc))

    latency = result.get("latency_ms", 0)
    resp = result.get("response_text", "")
    logger.info(f"[{req.session_id or '?'}] ← {resp[:60]} ({latency}ms)")

    return result


@app.get("/health")
async def health():
    """Health check del sidecar."""
    global _orchestrator
    if not _orchestrator:
        return {"status": "starting"}
    return {
        "status": "ok",
        "dialogue": _orchestrator.dialogue is not None,
        "memory": _orchestrator.memory is not None,
        "person_memory": _orchestrator.person_memory is not None,
        "tts": _orchestrator.tts is not None,
        "fast_rules": _orchestrator.fast_rules is not None,
        "current_state": _orchestrator._get_current_state(),
    }


@app.get("/")
async def root():
    return {
        "service": "Uchino Orchestrator",
        "version": "1.0.0",
        "endpoints": {
            "POST /orchestrate": "Procesar turno de conversación",
            "GET /health": "Health check",
        },
    }
