from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class MarketDataProviderError(RuntimeError):
    pass


class MarketDataProvider(ABC):
    name: str

    @abstractmethod
    def is_configured(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    def fetch_candles(self, symbol: str, interval: str, limit: int = 100) -> list[dict[str, Any]]:
        raise NotImplementedError

    def status(self) -> dict[str, Any]:
        return {'name': self.name, 'configured': self.is_configured()}
