from __future__ import annotations

import json
from typing import Any

from .config import MarketDataSettings


class MarketDataCache:
    """Read-only access to the Node hub Redis candle cache.

    Node writes keys as: kaching:candles:{SYMBOL}:{interval}:{limit}
    Payload shape: { candles: [...], provider, symbol, interval, ... }
    """

    def __init__(self, settings: MarketDataSettings):
        self.settings = settings
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
        return 'redis' if self._connect_redis() else 'unavailable'

    def get(self, key: str) -> dict[str, Any] | None:
        redis_client = self._connect_redis()
        if not redis_client:
            return None
        try:
            raw = redis_client.get(key)
            if raw:
                return json.loads(raw)
        except Exception:
            return None
        return None

    @staticmethod
    def build_hub_key(symbol: str, interval: str, limit: int) -> str:
        """Match MarketDataHubService.cacheRedisKey in Node."""
        return f'kaching:candles:{symbol}:{interval}:{limit}'
