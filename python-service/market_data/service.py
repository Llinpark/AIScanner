from __future__ import annotations

from typing import Any

import pandas as pd

from .base import MarketDataProvider, MarketDataProviderError
from .cache import MarketDataCache
from .config import MarketDataSettings, load_settings
from .eodhd_service import EodhdService
from .symbols import normalize_symbol, to_eodhd_symbol, to_twelve_data_interval, to_twelve_data_symbol
from .twelve_data_service import TwelveDataService


class MarketDataUnavailableError(RuntimeError):
    pass


class MarketDataService:
    """Provider-agnostic market data service with automatic fallback."""

    def __init__(self, settings: MarketDataSettings | None = None):
        self.settings = settings or load_settings()
        self.cache = MarketDataCache(self.settings)
        self.providers: dict[str, MarketDataProvider] = {
            'twelve_data': TwelveDataService(self.settings),
            'eodhd': EodhdService(self.settings),
        }

    def _provider_chain(self) -> list[MarketDataProvider]:
        chain: list[MarketDataProvider] = []
        for name in [self.settings.primary_provider, self.settings.fallback_provider]:
            provider = self.providers.get(name)
            if provider and provider not in chain:
                chain.append(provider)
        return chain

    def status(self) -> dict[str, Any]:
        return {
            'primary_provider': self.settings.primary_provider,
            'fallback_provider': self.settings.fallback_provider,
            'cache_backend': self.cache.backend,
            'cache_ttl_seconds': self.settings.cache_ttl_seconds,
            'stream_enabled': self.settings.stream_enabled,
            'providers': [provider.status() for provider in self.providers.values()],
        }

    def get_candles(self, symbol: str, interval: str = '1h', limit: int = 100) -> tuple[pd.DataFrame, dict[str, Any]]:
        normalized = normalize_symbol(symbol)
        cache_key = self.cache.build_key(normalized, interval, limit)
        cached = self.cache.get(cache_key)
        if cached:
            return pd.DataFrame(cached['candles']), cached['meta']

        errors: list[str] = []
        for provider in self._provider_chain():
            if not provider.is_configured():
                errors.append(f'{provider.name}: not configured')
                continue
            try:
                candles = provider.fetch_candles(normalized, interval, limit)
                meta = {
                    'provider': provider.name,
                    'symbol': normalized,
                    'provider_symbol': self._provider_symbol(provider.name, normalized),
                    'interval': interval,
                    'requested_limit': limit,
                    'count': len(candles),
                    'fallback_used': provider.name != self.settings.primary_provider,
                }
                self.cache.set(cache_key, {'candles': candles, 'meta': meta})
                return pd.DataFrame(candles).reset_index(drop=True), meta
            except (MarketDataProviderError, Exception) as exc:
                errors.append(f'{provider.name}: {exc}')

        raise MarketDataUnavailableError(' | '.join(errors) or 'No market data providers configured')

    def get_candles_payload(self, symbol: str, interval: str = '1h', limit: int = 100) -> dict[str, Any]:
        df, meta = self.get_candles(symbol, interval, limit)
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

    @staticmethod
    def _provider_symbol(provider_name: str, symbol: str) -> str:
        if provider_name == 'eodhd':
            return to_eodhd_symbol(symbol)
        return to_twelve_data_symbol(symbol)


market_data_service = MarketDataService()

__all__ = ['MarketDataService', 'market_data_service', 'MarketDataUnavailableError']
