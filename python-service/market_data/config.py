import os
from dataclasses import dataclass

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class MarketDataSettings:
    primary_provider: str
    fallback_provider: str
    twelve_data_api_key: str
    twelve_data_base_url: str
    eodhd_api_key: str
    eodhd_base_url: str
    cache_ttl_seconds: int
    stale_cache_seconds: int
    redis_url: str
    redis_enabled: bool
    stream_enabled: bool


def load_settings() -> MarketDataSettings:
    redis_url = os.getenv('REDIS_URL', 'redis://127.0.0.1:6379/0').strip()
    redis_flag = os.getenv('REDIS_ENABLED', 'true').strip().lower()
    return MarketDataSettings(
        primary_provider=os.getenv('MARKET_DATA_PRIMARY', 'twelve_data').strip().lower(),
        fallback_provider=os.getenv('MARKET_DATA_FALLBACK', 'eodhd').strip().lower(),
        twelve_data_api_key=os.getenv('TWELVE_DATA_API_KEY', '').strip(),
        twelve_data_base_url=os.getenv('TWELVE_DATA_BASE_URL', 'https://api.twelvedata.com').strip(),
        eodhd_api_key=os.getenv('EODHD_API_KEY', '').strip(),
        eodhd_base_url=os.getenv('EODHD_BASE_URL', 'https://eodhd.com/api').strip(),
        cache_ttl_seconds=max(60, int(os.getenv('MARKET_DATA_CACHE_TTL_SECONDS', '300') or 300)),
        stale_cache_seconds=max(120, int(os.getenv('MARKET_DATA_STALE_CACHE_SECONDS', '900') or 900)),
        redis_url=redis_url,
        redis_enabled=redis_flag in {'1', 'true', 'yes', 'on'},
        stream_enabled=os.getenv('MARKET_DATA_STREAM_ENABLED', 'true').strip().lower() in {'1', 'true', 'yes', 'on'},
    )
