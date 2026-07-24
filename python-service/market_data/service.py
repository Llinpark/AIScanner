from __future__ import annotations

from typing import Any, Iterable

import pandas as pd

from .cache import MarketDataCache
from .config import MarketDataSettings, load_settings
from .errors import CANDLES_REQUIRED_MESSAGE, USER_FACING_MARKET_DATA_UNAVAILABLE
from .symbols import normalize_interval, normalize_symbol


class MarketDataUnavailableError(RuntimeError):
    pass


def candles_to_dataframe(candles: Iterable[dict[str, Any]] | None) -> pd.DataFrame:
    """Normalize injected OHLC bars (from Node hub / request body) into a DataFrame."""
    rows: list[dict[str, Any]] = []
    for candle in candles or []:
        if not isinstance(candle, dict):
            continue
        raw_time = candle.get('timestamp', candle.get('time'))
        if raw_time is None:
            continue
        try:
            if isinstance(raw_time, (int, float)):
                ms = raw_time if raw_time > 1e12 else raw_time * 1000
                ts = pd.to_datetime(ms, unit='ms', utc=True)
            else:
                ts = pd.to_datetime(raw_time, utc=True)
            rows.append(
                {
                    'timestamp': ts,
                    'open': float(candle['open']),
                    'high': float(candle['high']),
                    'low': float(candle['low']),
                    'close': float(candle['close']),
                    'volume': float(candle.get('volume') or 0),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue

    if not rows:
        return pd.DataFrame(columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])

    df = pd.DataFrame(rows).sort_values('timestamp').drop_duplicates(subset=['timestamp'], keep='last')
    return df.reset_index(drop=True)


class MarketDataService:
    """Consumes candles injected by Node (request body) or shared Redis hub cache.

    Never calls Twelve Data, EODHD, or any external market-data HTTP API.
    """

    def __init__(self, settings: MarketDataSettings | None = None):
        self.settings = settings or load_settings()
        self.cache = MarketDataCache(self.settings)

    def status(self) -> dict[str, Any]:
        return {
            'mode': 'injected_or_redis',
            'providers': [],
            'external_http_fetch': False,
            'cache_backend': self.cache.backend,
            'cache_ttl_seconds': self.settings.cache_ttl_seconds,
            'redis_enabled': self.settings.redis_enabled,
            'note': 'Node MarketDataHubService owns Twelve Data / EODHD. FastAPI only reads Redis or request candles.',
        }

    def resolve_bars(
        self,
        symbol: str,
        interval: str = '1h',
        limit: int = 100,
        candles: list[dict[str, Any]] | None = None,
    ) -> tuple[pd.DataFrame, dict[str, Any]]:
        """Prefer explicit candles; otherwise read Node hub Redis cache."""
        if candles:
            df = candles_to_dataframe(candles)
            if df.empty:
                raise MarketDataUnavailableError(CANDLES_REQUIRED_MESSAGE)
            if limit and len(df) > limit:
                df = df.tail(limit).reset_index(drop=True)
            meta = {
                'provider': 'injected',
                'source': 'request_body',
                'symbol': normalize_symbol(symbol),
                'interval': normalize_interval(interval),
                'requested_limit': limit,
                'count': len(df),
                'fallback_used': False,
            }
            return df, meta

        return self.get_candles_from_redis(symbol, interval, limit)

    def get_candles_from_redis(
        self, symbol: str, interval: str = '1h', limit: int = 100
    ) -> tuple[pd.DataFrame, dict[str, Any]]:
        normalized = normalize_symbol(symbol)
        canonical = normalize_interval(interval)
        parsed_limit = max(1, int(limit or 100))

        # Try exact key, then common hub defaults (Node often caches limit=200).
        candidate_limits = [parsed_limit]
        for alt in (200, 100, 500):
            if alt not in candidate_limits:
                candidate_limits.append(alt)

        for key_limit in candidate_limits:
            key = self.cache.build_hub_key(normalized, canonical, key_limit)
            cached = self.cache.get(key)
            if not cached:
                continue
            raw_candles = cached.get('candles') if isinstance(cached, dict) else None
            df = candles_to_dataframe(raw_candles)
            if df.empty:
                continue
            if len(df) > parsed_limit:
                df = df.tail(parsed_limit).reset_index(drop=True)
            meta = {
                'provider': cached.get('provider') or 'redis',
                'source': 'redis_hub',
                'symbol': normalized,
                'interval': canonical,
                'requested_limit': parsed_limit,
                'count': len(df),
                'fallback_used': bool(cached.get('fallback_used')),
                'cache_key': key,
                'stale': bool(cached.get('stale')),
            }
            return df, meta

        print(f'[MarketData] Redis cache miss for {normalized} {canonical} (limit={parsed_limit})')
        raise MarketDataUnavailableError(USER_FACING_MARKET_DATA_UNAVAILABLE)

    def get_candles_payload(
        self,
        symbol: str,
        interval: str = '1h',
        limit: int = 100,
        candles: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        df, meta = self.resolve_bars(symbol, interval, limit, candles)
        rows = []
        for _, row in df.iterrows():
            ts = row['timestamp']
            rows.append(
                {
                    'timestamp': ts.isoformat() if hasattr(ts, 'isoformat') else str(ts),
                    'open': float(row['open']),
                    'high': float(row['high']),
                    'low': float(row['low']),
                    'close': float(row['close']),
                    'volume': float(row['volume']),
                }
            )
        return {**meta, 'candles': rows}


market_data_service = MarketDataService()

__all__ = [
    'MarketDataService',
    'market_data_service',
    'MarketDataUnavailableError',
    'candles_to_dataframe',
]
