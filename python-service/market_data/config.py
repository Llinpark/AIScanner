import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class MarketDataSettings:
    """Cache/read settings only — providers live in the Node hub."""

    cache_ttl_seconds: int
    stale_cache_seconds: int
    redis_url: str
    redis_enabled: bool


def load_settings() -> MarketDataSettings:
    redis_url = os.getenv('REDIS_URL', 'redis://127.0.0.1:6379/0').strip()
    redis_flag = os.getenv('REDIS_ENABLED', 'true').strip().lower()
    return MarketDataSettings(
        cache_ttl_seconds=max(60, int(os.getenv('MARKET_DATA_CACHE_TTL_SECONDS', '300') or 300)),
        stale_cache_seconds=max(120, int(os.getenv('MARKET_DATA_STALE_CACHE_SECONDS', '900') or 900)),
        redis_url=redis_url,
        redis_enabled=redis_flag in {'1', 'true', 'yes', 'on'},
    )
