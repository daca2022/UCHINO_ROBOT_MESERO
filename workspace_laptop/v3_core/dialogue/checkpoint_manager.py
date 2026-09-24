"""
Redis-backed checkpoint persistence for LangGraph dialogue state machine.
Saves full state after each turn with 1-hour TTL per session.
Supports multi-session resume after disconnect/timeout.
"""

import json
import time
from typing import Optional, Dict, Any
import redis


class CheckpointManager:
    """
    Persists dialogue state to Redis with manual JSON save/load.
    Session TTL: 1 hour. Supports multi-session resume after disconnect/timeout.
    """

    DEFAULT_TTL = 3600

    def __init__(self, host: str = "localhost", port: int = 6379, db: int = 0,
                 ttl: int = None, key_prefix: str = "chipi:dialogue:"):
        self.ttl = ttl or self.DEFAULT_TTL
        self.key_prefix = key_prefix
        self._redis = redis.Redis(host=host, port=port, db=db, decode_responses=True)

        try:
            self._redis.ping()
        except redis.ConnectionError:
            raise ConnectionError(f"Cannot connect to Redis at {host}:{port}")

    def save_manual(self, session_id: str, state: Dict[str, Any]) -> None:
        """
        Manual save of full dialogue state as JSON.
        Used for quick state queries without LangGraph's internal format.

        Args:
            session_id: Unique session identifier
            state: Full dialogue state dict (current_state, order, summary, etc.)
        """
        key = f"{self.key_prefix}state:{session_id}"
        payload = {
            **state,
            "_saved_at": time.time(),
            "_ttl": self.ttl,
        }
        self._redis.setex(key, self.ttl, json.dumps(payload, ensure_ascii=False, default=str))

    def load_manual(self, session_id: str) -> Optional[Dict[str, Any]]:
        """
        Load full dialogue state from manual save.

        Returns None if session not found or expired.
        """
        key = f"{self.key_prefix}state:{session_id}"
        raw = self._redis.get(key)
        if not raw:
            return None
        return json.loads(raw)

    def session_exists(self, session_id: str) -> bool:
        """Check if a session has saved state."""
        key = f"{self.key_prefix}state:{session_id}"
        return bool(self._redis.exists(key))

    def delete_session(self, session_id: str) -> None:
        """Delete all state for a session."""
        keys_pattern = f"{self.key_prefix}*{session_id}*"
        cursor = 0
        while True:
            cursor, keys = self._redis.scan(cursor, match=keys_pattern, count=100)
            if keys:
                self._redis.delete(*keys)
            if cursor == 0:
                break

    def refresh_ttl(self, session_id: str) -> bool:
        """Reset TTL on session to keep it alive."""
        key = f"{self.key_prefix}state:{session_id}"
        if self._redis.exists(key):
            self._redis.expire(key, self.ttl)
            return True
        return False

    def list_active_sessions(self) -> list:
        """List all session IDs with active checkpoints."""
        cursor = 0
        sessions = []
        pattern = f"{self.key_prefix}state:*"
        while True:
            cursor, keys = self._redis.scan(cursor, match=pattern, count=100)
            for key in keys:
                sid = key.replace(f"{self.key_prefix}state:", "")
                sessions.append(sid)
            if cursor == 0:
                break
        return sessions

    def health_check(self) -> bool:
        """Verify Redis connectivity."""
        try:
            return self._redis.ping()
        except Exception:
            return False
