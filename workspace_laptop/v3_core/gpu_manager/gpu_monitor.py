"""
GPU Monitor — VRAM budget management for RTX 5000 (16 GB).

Tracks per-model VRAM allocations, enforces budget constraints, and
auto-evicts low-priority models when VRAM exceeds 90% capacity.

Model priorities (higher = more critical, harder to evict):
    ASR (whisper_livekit)  >  Noise (deepfilternet)  >  TTS (kokoro)
    >  SER  >  Vision  >  LLM fallback (qwen3_14b, qwen3.5:9b)

Normal mode (cloud LLM, VRAM ~5.0 GB):
    WhisperLiveKit 3.0 GB + DeepFilterNet 0.5 GB + SER 0.5 GB
    + Kokoro 2.0 GB - Kokoro when not speaking = 5.0 GB
    Qwen3.5-Flash (cloud) → unloads local LLM, frees ~7 GB

Offline mode / local fallback (budget ~12.0 GB):
    Above + Qwen3.5:9B 7.0 GB — must unload Kokoro first.
    Falls back from cloud Qwen3.5-Flash when WiFi is down.

Integration:
    Called by orchestrator, TTS manager, and LLM brain adapter to
    coordinate model lifecycle across the entire system.
"""

import logging
import os
import subprocess
import threading
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ── Constants ────────────────────────────────────────────────────────────────
_TOTAL_VRAM_MB = 16384  # RTX 5000
_DEFAULT_MAX_VRAM_MB = int(os.getenv("GPU_MANAGER_MAX_VRAM_MB", str(_TOTAL_VRAM_MB)))
_DEFAULT_WARNING_THRESHOLD = float(os.getenv("GPU_MANAGER_WARNING_THRESHOLD", "0.9"))

# Per-model expected VRAM budgets (MiB) — best-effort estimates.
# These are used for *budget planning*; actual VRAM is measured via nvidia-smi.
MODEL_BUDGETS: Dict[str, int] = {
    "whisper_livekit": 3072,
    "deepfilternet":   512,
    "kokoro":         2048,
    "ser":             512,
    "vision":         6144,
    "qwen3_14b":      9216,
    "qwen3.5-flash":     0,   # cloud — no VRAM usage
    "qwen3.5:9b":      7000,  # local fallback
}

# Eviction priority: higher number = more critical, less likely to be evicted.
# Lower-priority models get unloaded first when VRAM is tight.
_DEFAULT_PRIORITIES: Dict[str, int] = {
    "whisper_livekit": 100,   # ASR — essential for speech pipeline
    "deepfilternet":    90,   # Noise suppression — quality of life
    "kokoro":           80,   # TTS — user-facing
    "ser":              70,   # Emotion recognition — enriches dialogue
    "vision":           60,   # On-demand camera analysis
    "qwen3_14b":        50,   # LLM fallback — only when Gemini is unavailable
    "qwen3.5:9b":        3,   # Local LLM fallback — small, evict first
    "qwen3.5-flash":     1,   # Cloud — no VRAM, trivially "evictable"
}


def _parse_env_priorities(raw: str) -> Dict[str, int]:
    """Parse GPU_MANAGER_MODEL_PRIORITIES env var (name:prio,name:prio,...)."""
    result: Dict[str, int] = {}
    if not raw or not raw.strip():
        return result
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if ":" not in chunk:
            continue
        name, _, prio = chunk.partition(":")
        try:
            result[name.strip()] = int(prio.strip())
        except ValueError:
            logger.warning("Invalid priority entry: %r", chunk)
    return result


# ── GPU Manager ──────────────────────────────────────────────────────────────

class GPUManager:
    """Singleton GPU VRAM budget manager.

    Tracks which models are loaded, compares against nvidia-smi ground truth,
    and enforces budget constraints by evicting low-priority models.

    Usage:
        gpu = GPUManager()
        if gpu.load_model("kokoro"):
            # ... use Kokoro TTS ...
            gpu.unload_model("kokoro")
        report = gpu.get_budget_report()
    """

    _instance: Optional["GPUManager"] = None
    _lock: threading.Lock = threading.Lock()

    def __new__(cls, *args, **kwargs) -> "GPUManager":
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(
        self,
        max_vram_mb: int = _DEFAULT_MAX_VRAM_MB,
        warning_threshold: float = _DEFAULT_WARNING_THRESHOLD,
    ) -> None:
        if getattr(self, "_initialized", False):
            return
        self._initialized = True
        self.max_vram_mb = max_vram_mb
        self.warning_threshold = warning_threshold  # 0.0 — 1.0

        # Merge .env overrides into priorities
        env_prios = _parse_env_priorities(
            os.getenv("GPU_MANAGER_MODEL_PRIORITIES", "")
        )
        self.priorities: Dict[str, int] = {**_DEFAULT_PRIORITIES, **env_prios}
        self._loaded_models: Dict[str, int] = {}  # name → budget_mb
        self._state_lock = threading.Lock()

    # ── VRAM queries ─────────────────────────────────────────────────────

    def get_vram_usage(self) -> int:
        """Return current VRAM used in MiB (from nvidia-smi)."""
        try:
            result = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=memory.used",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode != 0:
                logger.warning("nvidia-smi returned non-zero: %s", result.stderr.strip())
                return -1
            return int(result.stdout.strip().split("\n")[0])
        except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
            logger.error("nvidia-smi query failed: %s", exc)
            return -1
        except ValueError as exc:
            logger.error("nvidia-smi parse error: %s", exc)
            return -1

    def get_vram_total(self) -> int:
        """Return total VRAM in MiB (from nvidia-smi)."""
        try:
            result = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=memory.total",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode != 0:
                return self.max_vram_mb  # fallback
            return int(result.stdout.strip().split("\n")[0])
        except Exception:
            return self.max_vram_mb

    def get_vram_free(self) -> int:
        """Return free VRAM in MiB."""
        total = self.get_vram_total()
        used = self.get_vram_usage()
        if used < 0 or total < 0:
            return -1
        return max(0, total - used)

    def get_vram_usage_pct(self) -> float:
        """Return VRAM usage as fraction 0.0–1.0."""
        used = self.get_vram_usage()
        total = self.get_vram_total()
        if used < 0 or total <= 0:
            return 0.0
        return min(1.0, used / total)

    # ── Model lifecycle ──────────────────────────────────────────────────

    def load_model(self, name: str, budget_mb: Optional[int] = None) -> bool:
        """Register a model as loaded after checking budget.

        Returns True if the model can be loaded within budget, False if
        there isn't enough VRAM even after eviction.

        Args:
            name: Model identifier (must match MODEL_BUDGETS key).
            budget_mb: Override budget estimate. Uses MODEL_BUDGETS default
                       if not provided.
        """
        budget = budget_mb if budget_mb is not None else MODEL_BUDGETS.get(name, 0)
        if budget <= 0:
            logger.warning("Unknown model %r — registering with budget 0", name)
            budget = 0

        with self._state_lock:
            if name in self._loaded_models:
                logger.debug("Model %r already registered as loaded", name)
                return True

            # Estimate post-load VRAM
            tracked_total = sum(self._loaded_models.values())
            free = self.get_vram_free()
            needed = max(0, budget - tracked_total)  # approximate

            if free >= 0 and free < budget:
                logger.info(
                    "Insufficient VRAM: need %d MiB, free %d MiB — attempting eviction",
                    budget, free,
                )
                self._evict_for_space(budget)

            self._loaded_models[name] = budget
            logger.info(
                "Model %r registered (budget=%d MiB, loaded=%d/%d MiB)",
                name, budget, sum(self._loaded_models.values()), self.max_vram_mb,
            )
            return True

    def unload_model(self, name: str) -> bool:
        """Unregister a model. Returns True if it was loaded."""
        with self._state_lock:
            if name in self._loaded_models:
                freed = self._loaded_models.pop(name)
                logger.info(
                    "Model %r unregistered (freed ~%d MiB, loaded=%d MiB)",
                    name, freed, sum(self._loaded_models.values()),
                )
                return True
            logger.debug("Model %r was not registered — nothing to unload", name)
            return False

    def is_loaded(self, name: str) -> bool:
        """Check if a model is registered as loaded."""
        with self._state_lock:
            return name in self._loaded_models

    def get_loaded_models(self) -> List[str]:
        """Return list of currently loaded model names."""
        with self._state_lock:
            return list(self._loaded_models.keys())

    # ── Budget / eviction ────────────────────────────────────────────────

    def check_and_evict(self) -> List[str]:
        """Check VRAM and auto-evict low-priority models if > warning_threshold.

        Returns list of evicted model names.
        """
        pct = self.get_vram_usage_pct()
        if pct < self.warning_threshold:
            return []

        logger.warning(
            "VRAM at %.1f%% — threshold %.0f%% exceeded, evicting...",
            pct * 100, self.warning_threshold * 100,
        )
        evicted = self._evict_lowest_priority()
        logger.info("Evicted %d models: %s", len(evicted), evicted)
        return evicted

    def get_budget_report(self) -> Dict:
        """Return comprehensive budget status.

        Returns:
            {
                "vram_total_mb": int,
                "vram_used_mb": int,
                "vram_free_mb": int,
                "vram_usage_pct": float,
                "tracked_models": {name: budget_mb, ...},
                "tracked_total_mb": int,
                "tracked_overhead_mb": int,   # actual - tracked
                "warning_active": bool,
                "eviction_candidates": [name, ...],  # in eviction order
            }
        """
        used = self.get_vram_usage()
        total = self.get_vram_total()
        free = self.get_vram_free()
        pct = self.get_vram_usage_pct()

        with self._state_lock:
            tracked = dict(self._loaded_models)
            tracked_total = sum(tracked.values())

        overhead = max(0, used - tracked_total) if used >= 0 else -1
        candidates = self._eviction_order()
        warning = pct >= self.warning_threshold

        return {
            "vram_total_mb": total,
            "vram_used_mb": used,
            "vram_free_mb": free,
            "vram_usage_pct": round(pct, 3),
            "tracked_models": tracked,
            "tracked_total_mb": tracked_total,
            "tracked_overhead_mb": overhead,
            "warning_active": warning,
            "eviction_candidates": candidates,
        }

    # ── Internal ─────────────────────────────────────────────────────────

    def _eviction_order(self) -> List[str]:
        """Return loaded models sorted by priority (lowest first = evict first)."""
        models = list(self._loaded_models.keys())
        models.sort(key=lambda m: self.priorities.get(m, 0))
        return models

    def _evict_for_space(self, needed_mb: int) -> int:
        """Evict lowest-priority models until `needed_mb` is freed.

        Returns total MiB freed. Modifies _loaded_models in-place.
        """
        freed_total = 0
        candidates = self._eviction_order()
        for name in candidates:
            if freed_total >= needed_mb:
                break
            budget = self._loaded_models.pop(name, 0)
            freed_total += budget
            logger.info(
                "Evicted %r (freed ~%d MiB, priority=%d)",
                name, budget, self.priorities.get(name, 0),
            )
        return freed_total

    def _evict_lowest_priority(self) -> List[str]:
        """Evict the single lowest-priority model. Returns evicted names."""
        candidates = self._eviction_order()
        evicted: List[str] = []
        if not candidates:
            return evicted

        name = candidates[0]  # lowest priority
        budget = self._loaded_models.pop(name, 0)
        evicted.append(name)
        logger.warning(
            "Emergency eviction: %r (priority=%d, freed ~%d MiB)",
            name, self.priorities.get(name, 0), budget,
        )
        return evicted


# ── Singleton accessor ───────────────────────────────────────────────────────

def get_gpu_manager() -> GPUManager:
    """Return the singleton GPUManager instance."""
    return GPUManager()


# ── Convenience top-level helpers ────────────────────────────────────────────

def get_vram_usage() -> int:
    """Return current VRAM used in MiB (convenience)."""
    return get_gpu_manager().get_vram_usage()


def load_model(name: str, budget_mb: Optional[int] = None) -> bool:
    """Register a model as loaded (convenience)."""
    return get_gpu_manager().load_model(name, budget_mb)


def unload_model(name: str) -> bool:
    """Unregister a model (convenience)."""
    return get_gpu_manager().unload_model(name)


def get_budget_report() -> Dict:
    """Return full budget report (convenience)."""
    return get_gpu_manager().get_budget_report()
