#!/usr/bin/env python3
"""
Semantic Extractor — Extracts cafe rules from conversations using Qwen.
Pipeline: conversation -> Qwen extraction -> Qwen validation -> deduplicate -> store.

Uses OpenRouter (Qwen 3.5 Flash) instead of Gemini.
Raw conversations are discarded after extraction; only validated rules are stored.
"""

import json
import os
import hashlib
import time
from dataclasses import dataclass, field
from typing import Optional

from openai import OpenAI

from .mem0_setup import get_memory

_OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
_OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL",
                                       "https://openrouter.ai/api/v1")
_LLM_MODEL = os.environ.get("OPENROUTER_MODEL", "deepseek/deepseek-v4-flash")

_client: Optional[OpenAI] = None


def _get_client() -> Optional[OpenAI]:
    global _client
    if _client is None and _OPENROUTER_API_KEY:
        _client = OpenAI(api_key=_OPENROUTER_API_KEY, base_url=_OPENROUTER_BASE_URL)
    return _client


SYNAPSE_TURN_INTERVAL = 5  # Extract rules every N turns (arXiv 2601.02744)
MIN_CONFIDENCE_THRESHOLD = 0.95  # Rules below this are rejected

EXTRACTION_PROMPT = """You are a semantic rule extractor for a cafe robot waiter named Uchino.

Given the following conversation between Uchino and customers, extract general operational rules
that should be remembered for future interactions. Rules should be:

1. GENERAL, not tied to specific customers (those go to Person Memory)
2. ACTIONABLE — can guide future behavior
3. CONCISE — one sentence per rule
4. FACTUAL — only extract what was actually said, do NOT invent

Types of rules to extract:
- Menu changes or specials mentioned
- Operational procedures (e.g., "always offer dessert after main course")
- Cafe policies (e.g., "discounts for UTEC students on Wednesdays")
- Ingredient availability or substitutions
- Service preferences (e.g., "customers prefer being greeted in Spanish first")

Do NOT extract:
- Customer-specific preferences (those go to Person Memory)
- Transient information (e.g., "table 3 needs more napkins")
- Greetings, small talk, or non-operational content

Output format: JSON array of rules, each with {{ "rule": "...", "confidence": 0.0-1.0, "category": "...", "source_quote": "..." }}

If no rules can be extracted, return [].

Conversation:
{conversation}

Extracted rules (JSON array only, no markdown):"""

VALIDATION_PROMPT = """You are a validation system for a cafe robot's knowledge base.

A rule was extracted from a customer conversation. Your job is to validate it.

Check:
1. Is the rule factually supported by the source quote?
2. Is the rule hallucinated or made up?
3. Is the rule useful and actionable for a cafe robot?
4. Is the confidence score appropriate (>=0.95 for well-supported, <0.7 for speculative)?

Source quote: "{source_quote}"
Proposed rule: "{rule}"
Proposed confidence: {confidence}

Return JSON: {{ "valid": true/false, "adjusted_confidence": 0.0-1.0, "reason": "..." }}

Only return the JSON, no markdown:"""

CONFLICT_PROMPT = """You are resolving a conflict between two rules in a cafe robot's knowledge base.

Existing rule: "{existing}"
New rule: "{new}"

Determine if:
1. The new rule CONTRADICTS the existing (choose one)
2. The new rule SUPERSEDES the existing (newer information)
3. The new rule is a DUPLICATE (same meaning, different words)
4. The rules COEXIST (different aspects)

Return JSON: {{ "resolution": "contradict|supersede|duplicate|coexist", "chosen_rule": "...", "reasoning": "..." }}

Only return the JSON, no markdown:"""


@dataclass
class ExtractedRule:
    rule: str
    confidence: float
    category: str
    source_quote: str
    rule_id: str = ""
    created_at: float = field(default_factory=time.time)
    validated: bool = False
    validation_reason: str = ""

    def generate_id(self):
        content = f"{self.rule}|{self.category}"
        self.rule_id = hashlib.sha256(content.encode()).hexdigest()[:16]


class SynapseCollector:
    """Buffers conversation turns and triggers semantic extraction every N turns.

    Implements the SYNAPSE pattern (arXiv 2601.02744):
    - Collects conversation turns in a sliding window
    - Every SYNAPSE_TURN_INTERVAL turns, runs extraction pipeline
    - Stores only validated, deduplicated, high-confidence rules
    """

    def __init__(self, extractor: Optional["SemanticExtractor"] = None,
                 turn_interval: int = SYNAPSE_TURN_INTERVAL):
        self.extractor = extractor or SemanticExtractor()
        self.turn_interval = turn_interval
        self.turn_buffer: list[str] = []
        self.turn_count = 0
        self.total_stored = 0
        self.total_rejected = 0

    def add_turn(self, speaker: str, text: str) -> Optional[dict]:
        self.turn_buffer.append(f"{speaker}: {text}")
        self.turn_count += 1

        if self.turn_count >= self.turn_interval:
            return self._trigger_extraction()
        return None

    def _trigger_extraction(self) -> dict:
        conversation = "\n".join(self.turn_buffer)
        result = self.extractor.process_conversation(conversation)

        self.total_stored += result.get("stored", 0)
        self.total_rejected += result.get("rejected", 0)

        overlap = min(2, len(self.turn_buffer))
        self.turn_buffer = self.turn_buffer[-overlap:]
        self.turn_count = overlap

        result["total_stored"] = self.total_stored
        result["total_rejected"] = self.total_rejected
        result["turns_processed"] = self.turn_interval
        return result

    def flush(self) -> Optional[dict]:
        if not self.turn_buffer:
            return None
        return self._trigger_extraction()


class SemanticExtractor:
    def __init__(self, api_key: Optional[str] = None):
        self.client = OpenAI(
            api_key=api_key or _OPENROUTER_API_KEY,
            base_url=_OPENROUTER_BASE_URL,
        )
        self.memory = get_memory()

    def _call_llm(self, prompt: str) -> str:
        response = self.client.chat.completions.create(
            model=_LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
        )
        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("\n", 1)[0]
            if raw.startswith("json"):
                raw = raw[4:]
        return raw

    def extract_rules(self, conversation: str) -> list[ExtractedRule]:
        prompt = EXTRACTION_PROMPT.format(conversation=conversation)
        raw = self._call_llm(prompt)

        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return []

        rules = []
        for item in (data if isinstance(data, list) else [data]):
            rule = ExtractedRule(
                rule=item.get("rule", ""),
                confidence=float(item.get("confidence", 0.5)),
                category=item.get("category", "general"),
                source_quote=item.get("source_quote", ""),
            )
            rule.generate_id()
            rules.append(rule)

        return rules

    def validate_rule(self, rule: ExtractedRule) -> ExtractedRule:
        prompt = VALIDATION_PROMPT.format(
            source_quote=rule.source_quote,
            rule=rule.rule,
            confidence=rule.confidence,
        )
        raw = self._call_llm(prompt)

        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            rule.validated = False
            rule.validation_reason = "Failed to parse validation response"
            return rule

        rule.validated = bool(result.get("valid", False))
        rule.confidence = float(result.get("adjusted_confidence", rule.confidence))
        rule.validation_reason = str(result.get("reason", ""))
        return rule

    def resolve_conflict(self, existing_rule: str, new_rule: str) -> dict:
        prompt = CONFLICT_PROMPT.format(existing=existing_rule, new=new_rule)
        raw = self._call_llm(prompt)

        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"resolution": "coexist", "chosen_rule": new_rule, "reasoning": "Parse error"}

    def deduplicate(self, rule: ExtractedRule, threshold: float = 0.85) -> list[dict]:
        results = self.memory.search(
            rule.rule,
            top_k=5,
            filters={"user_id": "cafe_system"},
        )
        similar = []
        for r in results:
            score = r.get("score", 0)
            if score >= threshold:
                similar.append(r)
        return similar

    def store_rule(self, rule: ExtractedRule, user_id: str = "cafe_system") -> bool:
        self.memory.add(
            f"[{rule.category}] {rule.rule}",
            user_id=user_id,
            metadata={
                "rule_id": rule.rule_id,
                "category": rule.category,
                "confidence": rule.confidence,
                "source_quote": rule.source_quote,
                "validated": rule.validated,
                "memory_type": "semantic",
            },
        )
        return True

    def process_conversation(self, conversation: str, user_id: str = "cafe_system") -> dict:
        rules = self.extract_rules(conversation)
        if not rules:
            return {"stored": 0, "rejected": 0, "rules": [], "errors": []}

        stored = 0
        rejected = 0
        stored_rules = []
        errors = []

        for rule in rules:
            rule = self.validate_rule(rule)
            if not rule.validated or rule.confidence < MIN_CONFIDENCE_THRESHOLD:
                rejected += 1
                continue

            similar = self.deduplicate(rule)
            if similar:
                rejected += 1
                errors.append({"rule": rule.rule, "reason": "duplicate", "similar": similar[0]})
                continue

            self.store_rule(rule, user_id)
            stored += 1
            stored_rules.append({
                "rule": rule.rule,
                "category": rule.category,
                "confidence": rule.confidence,
            })

        return {
            "stored": stored,
            "rejected": rejected,
            "rules": stored_rules,
            "errors": errors,
        }
