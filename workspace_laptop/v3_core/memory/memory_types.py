#!/usr/bin/env python3
"""
Memory Types Registry — 7-layer architecture for the cafe robot.
Each type declares: description, storage backend, retrieval strategy, TTL.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional

# ── Storage Backend Enum ────────────────────────────────────────────


class StorageBackend(Enum):
    REDIS = "redis"
    POSTGRESQL = "postgresql"
    CHROMADB = "chromadb"
    MEM0 = "mem0"
    ROS2 = "ros2"
    SYSTEM_PROMPT = "system_prompt"
    LLM_WEIGHTS = "llm_weights"


# ── Memory Type Definition ─────────────────────────────────────────


@dataclass
class MemoryType:
    index: int
    name: str
    description: str
    storage: StorageBackend
    retrieval: str
    ttl: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    store_fn: Optional[Callable] = None
    recall_fn: Optional[Callable] = None


# ── 7-Layer Memory Registry ────────────────────────────────────────

MEMORY_TYPES: dict[str, MemoryType] = {
    # 1. Working Memory — active conversation state
    "working": MemoryType(
        index=1,
        name="Working Memory",
        description="Active conversation state, pending orders, current context. LangGraph checkpoint-based.",
        storage=StorageBackend.REDIS,
        retrieval="Direct key lookup by session_id",
        ttl="session_duration",
        tags=["conversation", "active", "checkpoint"],
    ),
    # 2. Episodic Memory — past events, order history
    "episodic": MemoryType(
        index=2,
        name="Episodic Memory",
        description="Past interactions: orders completed, conversations finished, events timeline.",
        storage=StorageBackend.POSTGRESQL,
        retrieval="SQL queries + ChromaDB semantic search by event description",
        ttl="permanent",
        tags=["events", "orders", "history", "timeline"],
    ),
    # 3. Semantic Memory — facts, rules, knowledge about the cafe
    "semantic": MemoryType(
        index=3,
        name="Semantic Memory",
        description="Cafe facts, extracted rules, menu knowledge, operational procedures.",
        storage=StorageBackend.MEM0,
        retrieval="Mem0 semantic search + vector similarity on rules",
        ttl="permanent",
        tags=["facts", "rules", "knowledge", "menu"],
    ),
    # 4. Spatial Memory — locations, maps, navigation
    "spatial": MemoryType(
        index=4,
        name="Spatial Memory",
        description="Cafe layout, table positions, navigation waypoints, SLAM map annotations.",
        storage=StorageBackend.ROS2,
        retrieval="Nav2 map server + TF transforms + SLAM annotations",
        ttl="permanent",
        tags=["navigation", "map", "slam", "waypoints"],
    ),
    # 5. Person Memory — user profiles, preferences
    "person": MemoryType(
        index=5,
        name="Person Memory",
        description="Individual customer profiles: preferences, allergies, visit history, names.",
        storage=StorageBackend.MEM0,
        retrieval="Mem0 user_id lookup + preference vector search",
        ttl="permanent",
        tags=["users", "profiles", "preferences", "allergies"],
    ),
    # 6. Procedural Memory — how to do things
    "procedural": MemoryType(
        index=6,
        name="Procedural Memory",
        description="Task procedures: take_order, deliver_food, greet_customer. System prompts + function calling.",
        storage=StorageBackend.SYSTEM_PROMPT,
        retrieval="Function calling definitions + Gemini system instructions",
        ttl="permanent",
        tags=["procedures", "functions", "tasks", "skills"],
    ),
    # 7. Implicit Memory — model weights, fine-tuned patterns
    "implicit": MemoryType(
        index=7,
        name="Implicit Memory",
        description="LLM weights, fine-tuned behavioral patterns. Stored in Gemini model itself.",
        storage=StorageBackend.LLM_WEIGHTS,
        retrieval="Gemini inference (not locally retrievable)",
        ttl="permanent",
        tags=["weights", "model", "fine-tuned", "patterns"],
    ),
}


def get_memory_types() -> dict[str, MemoryType]:
    return MEMORY_TYPES


def get_type_by_index(index: int) -> Optional[MemoryType]:
    for mt in MEMORY_TYPES.values():
        if mt.index == index:
            return mt
    return None


def get_types_by_tag(tag: str) -> list[MemoryType]:
    return [mt for mt in MEMORY_TYPES.values() if tag in mt.tags]


def list_types() -> list[dict]:
    return [
        {
            "index": mt.index,
            "name": mt.name,
            "description": mt.description,
            "storage": mt.storage.value,
            "retrieval": mt.retrieval,
            "ttl": mt.ttl,
            "tags": mt.tags,
        }
        for mt in MEMORY_TYPES.values()
    ]


if __name__ == "__main__":
    import json
    print(json.dumps(list_types(), indent=2, ensure_ascii=False))
