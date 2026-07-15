from __future__ import annotations

import json
import time
from typing import Any

from .config import MarketDataSettings


class MarketDataCache:
    """Redis-backed cache with in-memory fallback."""

    def __init__(self, settings: MarketDataSettings):
        self.settings = settings
        self._memory: dict[str, tuple[float, dict[str, Any]]] = {}
        self._redis = None
        self._redis_checked = False

    def _connect_redis(self):
        if self._redis_checked:
            return self._redis
        self._redis_checked = True
        if not self.settings.redis_enabled:
            return None
        try:
            import redis

            client = redis.from_url(self.settings.redis_url, decode_responses=True)
            client.ping()
            self._redis = client
        except Exception:
            self._redis = None
        return self._redis

    @property
    def backend(self) -> str:
        return 'redis' if self._connect_redis() else 'memory'

    def get(self, key: str) -> dict[str, Any] | None:
        redis_client = self._connect_redis()
        if redis_client:
            try:
                raw = redis_client.get(key)
                if raw:
                    return json.loads(raw)
            except Exception:
                pass

        entry = self._memory.get(key)
        if not entry:
            return None
        expires_at, stored_at, payload = entry
        if time.time() >= expires_at:
            self._memory.pop(key, None)
            return None
        return payload

    def get_stale(self, key: str) -> dict[str, Any] | None:
        fresh = self.get(key)
        if fresh:
            return fresh

        entry = self._memory.get(key)
        if not entry:
            return None

        _expires_at, stored_at, payload = entry
        if time.time() - stored_at > self.settings.stale_cache_seconds:
            self._memory.pop(key, None)
            return None
        return payload

    def set(self, key: str, payload: dict[str, Any]) -> None:
        redis_client = self._connect_redis()
        if redis_client:
            try:
                redis_client.setex(key, self.settings.cache_ttl_seconds, json.dumps(payload, default=str))
            except Exception:
                pass

        expires_at = time.time() + self.settings.cache_ttl_seconds
        self._memory[key] = (expires_at, time.time(), payload)

    def build_key(self, symbol: str, interval: str, limit: int) -> str:
        return f'market:candles:{symbol}:{interval}:{limit}'
