from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from datetime import datetime
from data_ingestion import fetch_alpha_vantage_series
from indicators import compute_rsi, compute_macd, compute_bollinger
from model import generate_signals, LSTMSignalModel

app = FastAPI(title='KachingScanner Python Service')

class SignalRequest(BaseModel):
    symbol: str
    interval: str = '60min'
    source: str = 'alpha_vantage'
    lookback: int = 200

class SignalResponse(BaseModel):
    symbol: str
    timestamp: datetime
    direction: str
    entry: float
    stop_loss: float
    take_profit_1: float
    take_profit_2: float
    take_profit_3: float
    confidence: float
    notes: str

model = LSTMSignalModel()

@app.get('/health')
def health_check():
    return {'status': 'ok', 'service': 'python-ai-scanner'}

@app.post('/signal', response_model=SignalResponse)
def create_signal(request: SignalRequest):
    try:
        symbol = request.symbol
        interval = request.interval
        lookback = request.lookback

        bars = fetch_alpha_vantage_series(symbol, interval=interval, lookback=lookback)
        if bars is None or bars.empty:
            raise HTTPException(status_code=404, detail='Market data unavailable')

        bars['rsi'] = compute_rsi(bars['close'])
        bars['macd'], bars['macd_signal'] = compute_macd(bars['close'])
        bars['bb_upper'], bars['bb_middle'], bars['bb_lower'] = compute_bollinger(bars['close'])

        signal = generate_signals(symbol, bars, model)
        return signal
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
