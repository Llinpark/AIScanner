"""User-facing market-data error helpers.

Keep technical cache/injection details in logs; return calm copy to clients.
"""

from __future__ import annotations

USER_FACING_MARKET_DATA_UNAVAILABLE = (
    'Market data is temporarily unavailable. Please try again shortly.'
)

CANDLES_REQUIRED_MESSAGE = (
    'Candles are required. Pass OHLC bars in the request body, or ensure Node has '
    'populated the shared Redis cache (kaching:candles:*).'
)


def is_provider_technical_error(message: str | None) -> bool:
    text = str(message or '').lower()
    if not text:
        return False
    return (
        'twelve_data' in text
        or 'eodhd' in text
        or 'twelvedata.com' in text
        or 'eodhistoricaldata' in text
        or 'api key' in text
        or 'not configured' in text
        or 'no market data' in text
        or 'redis' in text
        or 'cache miss' in text
        or 'candles are required' in text
        or 'cached data unavailable' in text
    )


def to_user_facing_market_data_error(
    message: str | None,
    fallback: str = USER_FACING_MARKET_DATA_UNAVAILABLE,
) -> str:
    if not message:
        return fallback
    if is_provider_technical_error(message):
        return USER_FACING_MARKET_DATA_UNAVAILABLE
    return str(message)
