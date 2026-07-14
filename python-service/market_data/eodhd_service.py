from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import requests

from .base import MarketDataProvider, MarketDataProviderError
from .config import MarketDataSettings
from .symbols import is_daily_interval, to_eodhd_intraday_interval, to_eodhd_symbol


class EodhdService(MarketDataProvider):
    name = 'eodhd'

    def __init__(self, settings: MarketDataSettings):
        self.settings = settings

    def is_configured(self) -> bool:
        return bool(self.settings.eodhd_api_key)

    @staticmethod
    def _parse_datetime(value: str | int | float) -> datetime:
        if value is None:
            return datetime.now(timezone.utc)
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        raw = str(value).strip()
        try:
            if raw.isdigit():
                return datetime.fromtimestamp(int(raw), tz=timezone.utc)
            return datetime.fromisoformat(f'{raw}+00:00')
        except ValueError:
            return datetime.now(timezone.utc)

    def _fetch_eod(self, ticker: str, limit: int) -> list[dict[str, Any]]:
        url = f'{self.settings.eodhd_base_url.rstrip("/")}/eod/{ticker}'
        params = {
            'api_token': self.settings.eodhd_api_key,
            'fmt': 'json',
            'order': 'a',
            'period': 'd',
        }
        response = requests.get(url, params=params, timeout=20)
        payload = response.json()
        if not response.ok:
            raise MarketDataProviderError(str(payload))

        rows = payload if isinstance(payload, list) else payload.get('data') or []
        candles = []
        for row in rows[-limit:]:
            candles.append(
                {
                    'timestamp': self._parse_datetime(row.get('date')),
                    'open': float(row['open']),
                    'high': float(row['high']),
                    'low': float(row['low']),
                    'close': float(row['close']),
                    'volume': float(row.get('volume') or 0),
                }
            )
        if not candles:
            raise MarketDataProviderError(f'EODHD EOD returned no candles for {ticker}')
        return candles

    def _fetch_intraday(self, ticker: str, interval: str, limit: int) -> list[dict[str, Any]]:
        url = f'{self.settings.eodhd_base_url.rstrip("/")}/intraday/{ticker}'
        params = {
            'api_token': self.settings.eodhd_api_key,
            'fmt': 'json',
            'interval': to_eodhd_intraday_interval(interval),
        }
        response = requests.get(url, params=params, timeout=20)
        payload = response.json()
        if not response.ok:
            raise MarketDataProviderError(str(payload))

        rows = payload if isinstance(payload, list) else payload.get('data') or []
        candles = []
        for row in rows[-limit:]:
            ts = row.get('timestamp') or row.get('datetime')
            candles.append(
                {
                    'timestamp': self._parse_datetime(ts),
                    'open': float(row['open']),
                    'high': float(row['high']),
                    'low': float(row['low']),
                    'close': float(row['close']),
                    'volume': float(row.get('volume') or 0),
                }
            )
        if not candles:
            raise MarketDataProviderError(f'EODHD intraday returned no candles for {ticker}')
        candles.sort(key=lambda item: item['timestamp'])
        return candles[-limit:]

    def fetch_candles(self, symbol: str, interval: str, limit: int = 100) -> list[dict[str, Any]]:
        if not self.is_configured():
            raise MarketDataProviderError('EODHD_API_KEY is not configured')

        ticker = to_eodhd_symbol(symbol)
        outputsize = max(1, min(int(limit or 100), 5000))

        if is_daily_interval(interval):
            return self._fetch_eod(ticker, outputsize)
        return self._fetch_intraday(ticker, interval, outputsize)
