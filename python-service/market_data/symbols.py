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
    'USDBTC': 'USD/BTC',
    'BTCUSD': 'USD/BTC',
}

TWELVE_DATA_SYMBOL_MAP = {
    'US30': 'DJI',
    'US100': 'NDX',
    'USD/BTC': 'BTC/USD',
}

EODHD_SYMBOL_MAP = {
    'EUR/USD': 'EURUSD.FOREX',
    'GBP/USD': 'GBPUSD.FOREX',
    'XAU/USD': 'XAUUSD.FOREX',
    'XAG/USD': 'XAGUSD.FOREX',
    'AUD/USD': 'AUDUSD.FOREX',
    'USD/JPY': 'USDJPY.FOREX',
    'USD/CAD': 'USDCAD.FOREX',
    'NZD/USD': 'NZDUSD.FOREX',
    'USD/CHF': 'USDCHF.FOREX',
    'EUR/GBP': 'EURGBP.FOREX',
    'EUR/JPY': 'EURJPY.FOREX',
    'GBP/JPY': 'GBPJPY.FOREX',
    'US30': 'DJI.INDX',
    'US100': 'NDX.INDX',
    'USD/BTC': 'BTC-USD.CC',
}

INTERVAL_MAP = {
    '1m': '1min',
    '1min': '1min',
    '5m': '5min',
    '5min': '5min',
    '15m': '15min',
    '15min': '15min',
    '30m': '30min',
    '30min': '30min',
    '1h': '1h',
    '60min': '1h',
    '4h': '4h',
    '1D': '1day',
    '1day': '1day',
    '1W': '1week',
    '1week': '1week',
}

EODHD_INTRADAY_INTERVAL_MAP = {
    '1m': '1m',
    '1min': '1m',
    '5m': '5m',
    '5min': '5m',
    '15m': '5m',
    '15min': '5m',
    '30m': '5m',
    '30min': '5m',
    '1h': '1h',
    '60min': '1h',
    '4h': '1h',
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


def to_twelve_data_symbol(symbol: str) -> str:
    normalized = normalize_symbol(symbol)
    return TWELVE_DATA_SYMBOL_MAP.get(normalized, normalized)


def to_eodhd_symbol(symbol: str) -> str:
    normalized = normalize_symbol(symbol)
    if normalized in EODHD_SYMBOL_MAP:
        return EODHD_SYMBOL_MAP[normalized]
    compact = normalized.replace('/', '')
    if normalized in {'US30', 'US100'}:
        return EODHD_SYMBOL_MAP[normalized]
    return f'{compact}.FOREX'


def to_twelve_data_interval(interval: str) -> str:
    key = str(interval or '1h').strip()
    return INTERVAL_MAP.get(key, key)


def to_eodhd_intraday_interval(interval: str) -> str:
    key = str(interval or '1h').strip()
    return EODHD_INTRADAY_INTERVAL_MAP.get(key, '1h')


def is_daily_interval(interval: str) -> bool:
    key = str(interval or '').strip().lower()
    return key in {'1d', '1day', '1w', '1week'}
