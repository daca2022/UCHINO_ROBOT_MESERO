#!/usr/bin/env python3
"""
v3_core/memory — 7-Layer Memory Module for Chipi Cafe Robot
=============================================================
Mem0 Self-Hosted ($0) with ChromaDB + Gemini integration.

Usage:
    from v3_core.memory import get_memory, SemanticExtractor, PersonMemory
    from v3_core.memory.memory_types import MEMORY_TYPES, list_types
"""

from .mem0_setup import get_memory, get_config, test_connection
from .semantic_extractor import SemanticExtractor, ExtractedRule, SynapseCollector
from .person_memory import PersonMemory, create_user_id, verify_privacy
from .memory_types import (
    MEMORY_TYPES,
    MemoryType,
    StorageBackend,
    get_memory_types,
    get_type_by_index,
    get_types_by_tag,
    list_types,
)

__all__ = [
    "get_memory",
    "get_config",
    "test_connection",
    "SemanticExtractor",
    "ExtractedRule",
    "SynapseCollector",
    "PersonMemory",
    "create_user_id",
    "verify_privacy",
    "MEMORY_TYPES",
    "MemoryType",
    "StorageBackend",
    "get_memory_types",
    "get_type_by_index",
    "get_types_by_tag",
    "list_types",
]
