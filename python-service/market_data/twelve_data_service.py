from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import requests

from .base import MarketDataProvider, MarketDataProviderError
from .config import MarketDataSettings
from .symbols import to_twelve_data_interval, to_twelve_data_symbol


class TwelveDataService(MarketDataProvider):
    name = 'twelve_data'

    def __init__(self, settings: MarketDataSettings):
        self.settings = settings

    def is_configured(self) -> bool:
        return bool(self.settings.twelve_data_api_key)

    @staticmethod
    def _parse_datetime(value: str) -> datetime:
        raw = str(value or '').strip()
        if not raw:
            return datetime.now(timezone.utc)
        try:
            if raw.endswith('Z'):
                return datetime.fromisoformat(raw.replace('Z', '+00:00'))
            return datetime.fromisoformat(f'{raw}+00:00')
        except ValueError:
            return datetime.now(timezone.utc)

    def fetch_candles(self, symbol: str, interval: str, limit: int = 100) -> list[dict[str, Any]]:
        if not self.is_configured():
            raise MarketDataProviderError('TWELVE_DATA_API_KEY is not configured')

        td_symbol = to_twelve_data_symbol(symbol)
        td_interval = to_twelve_data_interval(interval)
        outputsize = max(1, min(int(limit or 100), 5000))

        url = f'{self.settings.twelve_data_base_url.rstrip("/")}/time_series'
        params = {
            'symbol': td_symbol,
            'interval': td_interval,
            'outputsize': outputsize,
            'order': 'asc',
            'timezone': 'UTC',
            'apikey': self.settings.twelve_data_api_key,
        }

        response = requests.get(url, params=params, timeout=20)
        payload = response.json()

        if not response.ok:
            raise MarketDataProviderError(payload.get('message') or f'Twelve Data HTTP {response.status_code}')

        if payload.get('status') == 'error':
            raise MarketDataProviderError(payload.get('message') or 'Twelve Data API error')

        candles: list[dict[str, Any]] = []
        for row in payload.get('values') or []:
            candles.append(
                {
                    'timestamp': self._parse_datetime(row.get('datetime')),
                    'open': float(row['open']),
                    'high': float(row['high']),
                    'low': float(row['low']),
                    'close': float(row['close']),
                    'volume': float(row.get('volume') or 0),
                }
            )

        if not candles:
            raise MarketDataProviderError(f'Twelve Data returned no candles for {td_symbol}')

        candles.sort(key=lambda item: item['timestamp'])
        return candles[-outputsize:]
