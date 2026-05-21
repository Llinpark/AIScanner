import os
import requests
import pandas as pd
from dotenv import load_dotenv

load_dotenv()

ALPHA_VANTAGE_API_KEY = os.getenv('ALPHA_VANTAGE_API_KEY', '')


def fetch_alpha_vantage_series(symbol: str, interval: str = '60min', lookback: int = 200):
    if not ALPHA_VANTAGE_API_KEY:
        raise RuntimeError('ALPHA_VANTAGE_API_KEY is not configured')

    url = 'https://www.alphavantage.co/query'
    params = {
        'function': 'TIME_SERIES_INTRADAY',
        'symbol': symbol,
        'interval': interval,
        'outputsize': 'compact',
        'apikey': ALPHA_VANTAGE_API_KEY
    }
    response = requests.get(url, params=params, timeout=20)
    response.raise_for_status()
    data = response.json()

    key = f'Time Series ({interval})'
    if key not in data:
        raise RuntimeError('Alpha Vantage response missing time series data')

    rows = []
    for timestamp, values in data[key].items():
        rows.append({
            'timestamp': pd.to_datetime(timestamp),
            'open': float(values['1. open']),
            'high': float(values['2. high']),
            'low': float(values['3. low']),
            'close': float(values['4. close']),
            'volume': float(values['5. volume'])
        })

    df = pd.DataFrame(rows).sort_values('timestamp').reset_index(drop=True)
    return df.tail(lookback)
