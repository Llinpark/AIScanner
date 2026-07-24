"""Symbol / interval normalization aligned with the Node market-data hub."""

SYMBOL_ALIASES = {
    'EURUSD': 'EUR/USD',
    'GBPUSD': 'GBP/USD',
    'XAUUSD': 'XAU/USD',
    'XAGUSD': 'XAG/USD',
    'AUDUSD': 'AUD/USD',
    'USDJPY': 'USD/JPY',
    'USDCAD': 'USD/CAD',
    'NZDUSD': 'NZD/USD',
    'USDCHF': 'USD/CHF',
    'EURGBP': 'EUR/GBP',
    'EURJPY': 'EUR/JPY',
    'GBPJPY': 'GBP/JPY',
    'USDBTC': 'BTC/USD',
    'BTCUSD': 'BTC/USD',
    'USD/BTC': 'BTC/USD',
}

INTERVAL_ALIASES = {
    '1m': '1m',
    '1min': '1m',
    '5m': '5m',
    '5min': '5m',
    '15m': '15m',
    '15min': '15m',
    '30m': '30m',
    '30min': '30m',
    '1h': '1h',
    '60min': '1h',
    '60m': '1h',
    '4h': '4h',
    '1d': '1d',
    '1D': '1d',
    '1day': '1d',
    '1w': '1w',
    '1W': '1w',
    '1week': '1w',
}


def normalize_symbol(symbol: str) -> str:
    raw = str(symbol or '').strip().upper().replace(' ', '')
    if not raw:
        return ''
    if raw in SYMBOL_ALIASES:
        return SYMBOL_ALIASES[raw]
    if '/' in raw:
        return raw
    if raw in {'US30', 'US100'}:
        return raw
    if len(raw) == 6:
        return f'{raw[:3]}/{raw[3:]}'
    return raw


def normalize_interval(interval: str) -> str:
    key = str(interval or '1h').strip()
    return INTERVAL_ALIASES.get(key, INTERVAL_ALIASES.get(key.lower(), key.lower() or '1h'))
