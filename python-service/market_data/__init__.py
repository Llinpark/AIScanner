"""Market data package — Twelve Data primary, EODHD automatic fallback."""

from .service import MarketDataService, market_data_service

__all__ = ['MarketDataService', 'market_data_service']
