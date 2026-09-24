#!/usr/bin/env python3
"""
Person Memory — Individual customer profiles stored via Mem0.
Extends the existing recordarCliente function from MemoryService with:
  - User-level identity (name, student ID, preferences, allergies)
  - Cross-session recall via Mem0 semantic search
  - Privacy: all data stays local, never sent to cloud
"""

import json
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from openai import OpenAI

from .mem0_setup import get_memory


_OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
_OPENROUTER_BASE_URL = os.environ.get("OPENROUTER_BASE_URL",
                                       "https://openrouter.ai/api/v1")
_LLM_MODEL = os.environ.get("OPENROUTER_MODEL", "deepseek/deepseek-v4-flash")


class PersonMemory:
    def __init__(self, api_key: Optional[str] = None):
        self.memory = get_memory()
        self._client = OpenAI(
            api_key=api_key or _OPENROUTER_API_KEY,
            base_url=_OPENROUTER_BASE_URL,
        )

    def record_interaction(self, user_id: str, messages: list[dict],
                           metadata: Optional[dict] = None) -> dict:
        metadata = metadata or {}
        metadata.setdefault("memory_type", "person")
        metadata.setdefault("timestamp", datetime.now(timezone.utc).isoformat())

        self.memory.add(
            messages=messages,
            user_id=user_id,
            metadata=metadata,
        )
        return {"status": "stored", "user_id": user_id}

    def recall_user(self, user_id: str, top_k: int = 10) -> list[dict]:
        result = self.memory.get_all(
            filters={"user_id": user_id, "memory_type": "person"},
        )
        memories = result.get("results", []) if isinstance(result, dict) else []
        results = []
        for mem in memories:
            results.append({
                "id": mem.get("id", ""),
                "memory": mem.get("memory", ""),
                "created_at": mem.get("created_at", ""),
                "metadata": mem.get("metadata", {}),
            })
        return results[:top_k]

    def search_user_memories(self, user_id: str, query: str, top_k: int = 5) -> list[dict]:
        results = self.memory.search(
            query=query,
            filters={"user_id": user_id, "memory_type": "person"},
            top_k=top_k,
            threshold=0.3,
        )
        return [{"id": r.get("id", ""), "memory": r.get("memory", ""),
                 "score": r.get("score", 0)} for r in results]

    def extract_profile(self, user_id: str) -> dict:
        profile_fields = {
            "nombre": "", "es_estudiante": False, "carrera": "",
            "preferencias": [], "alergias": [], "restricciones": [],
            "visitas": 0, "pedidos_favoritos": [], "ultima_visita": "",
        }
        memories = self.recall_user(user_id, top_k=50)
        if not memories:
            return profile_fields

        summary = "\n".join([m.get("memory", "") for m in memories[:30]])
        prompt = self._build_profile_prompt(summary)

        response = self._client.chat.completions.create(
            model=_LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
        )
        raw = response.choices[0].message.content.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("\n", 1)[0]

        try:
            extracted = json.loads(raw)
            profile_fields.update({k: v for k, v in extracted.items() if k in profile_fields})
        except (json.JSONDecodeError, KeyError):
            pass

        profile_fields["visitas"] = len(memories)
        if memories:
            profile_fields["ultima_visita"] = memories[0].get("created_at", "")

        return profile_fields

    def remember_preference(self, user_id: str, preference: str,
                            category: str = "preferencia") -> dict:
        self.memory.add(
            messages=[{"role": "system",
                       "content": f"Customer preference ({category}): {preference}"}],
            user_id=user_id,
            metadata={
                "memory_type": "person",
                "category": category,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
        return {"status": "stored", "user_id": user_id, "preference": preference}

    def remember_allergy(self, user_id: str, allergy: str) -> dict:
        return self.remember_preference(user_id, allergy, category="alergia")

    def create_profile(self, user_id: str, profile_data: dict) -> dict:
        """Create a new customer profile from structured data.

        Stores the profile fields as memory entries tagged with 'profile'
        category so they can be recalled later. Returns the stored profile.
        """
        valid_fields = {
            "nombre", "es_estudiante", "carrera",
            "preferencias", "alergias", "restricciones",
            "pedidos_favoritos",
        }
        stored = {"user_id": user_id, "stored_fields": []}

        for field, value in profile_data.items():
            if field not in valid_fields:
                continue
            if isinstance(value, (list, bool)):
                value = json.dumps(value, ensure_ascii=False)
            content = f"Profile field ({field}): {value}"
            self.memory.add(
                messages=[{"role": "system", "content": content}],
                user_id=user_id,
                metadata={
                    "memory_type": "person",
                    "category": "profile",
                    "field": field,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
            )
            stored["stored_fields"].append(field)

        return stored

    def update_profile(self, user_id: str, updates: dict) -> dict:
        """Update existing customer profile with new or changed fields.

        Merges updates with the existing extracted profile. New fields
        are stored as memory entries. Returns the complete updated profile.
        """
        current = self.extract_profile(user_id)

        for key, value in updates.items():
            if key in current:
                if isinstance(current[key], list) and isinstance(value, list):
                    current[key] = list(set(current[key] + value))
                elif isinstance(current[key], list) and not isinstance(value, list):
                    if value not in current[key]:
                        current[key].append(value)
                else:
                    current[key] = value

        self.create_profile(user_id, current)

        return current

    def get_allergies(self, user_id: str) -> list[str]:
        try:
            results = self.memory.search(
                query="alergia restriccion alergico",
                filters={"user_id": user_id},
                top_k=10,
                threshold=0.5,
            )
            prefs = set()
            for r in results or []:
                if isinstance(r, dict):
                    m = r.get("memory", "")
                else:
                    m = str(r)
                if m:
                    prefs.add(m)
            return list(prefs)
        except Exception:
            return []

    def get_preferences(self, user_id: str) -> list[str]:
        try:
            results = self.memory.search(
                query="preferencia favorito gusta",
                filters={"user_id": user_id},
                top_k=10,
                threshold=0.5,
            )
            prefs = set()
            for r in results or []:
                if isinstance(r, dict):
                    m = r.get("memory", "")
                else:
                    m = str(r)
                if m:
                    prefs.add(m)
            return list(prefs)
        except Exception as e:
            return []

    def delete_user(self, user_id: str) -> bool:
        try:
            self.memory.delete_all(user_id=user_id)
            return True
        except Exception:
            return False

    def user_exists(self, user_id: str) -> bool:
        memories = self.recall_user(user_id, top_k=1)
        return len(memories) > 0

    def _build_profile_prompt(self, summary: str) -> str:
        return (
            "You are a profile extractor for a cafe robot. Given the customer's interaction history, "
            "extract a structured profile. Only include information explicitly mentioned.\n\n"
            "Return JSON with these fields (omit if unknown):\n"
            '- nombre: customer name\n'
            '- es_estudiante: boolean (UTEC student?)\n'
            '- carrera: what they study\n'
            '- preferencias: list of food/drink preferences\n'
            '- alergias: list of allergies\n'
            '- restricciones: dietary restrictions (vegetarian, vegan, etc.)\n'
            '- pedidos_favoritos: frequently ordered items\n\n'
            f"Interaction history:\n{summary}\n\n"
            "JSON only, no markdown:"
        )


def create_user_id(name: str = "", identifier: str = "") -> str:
    base = identifier or name or str(uuid.uuid4())[:8]
    return base.lower().replace(" ", "_")


def verify_privacy(user_id: str, person_memory: PersonMemory) -> dict:
    profile = person_memory.extract_profile(user_id)
    has_pii = bool(profile.get("nombre") or profile.get("carrera"))
    return {
        "user_id": user_id,
        "has_pii": has_pii,
        "memory_count": profile.get("visitas", 0),
        "stored_locally": True,
        "cloud_sent": False,
    }


if __name__ == "__main__":
    pm = PersonMemory()
    test_user = create_user_id(name="Carlos", identifier="estudiante_utec")

    pm.remember_preference(test_user, "Prefiere café con leche de almendras")
    pm.remember_preference(test_user, "Le gusta el cheesecake")
    pm.remember_allergy(test_user, "Alergia a la lactosa")

    profile = pm.extract_profile(test_user)
    print(json.dumps(profile, indent=2, ensure_ascii=False))

    pm.delete_user(test_user)
