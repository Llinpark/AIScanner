from datetime import datetime

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from indicators import compute_bollinger, compute_macd, compute_rsi
from market_data import market_data_service
from market_data.router import router as market_data_router
from market_data.service import MarketDataUnavailableError
from model import LSTMSignalModel, generate_signals

app = FastAPI(title='KachingScanner Market Data & AI Service')
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:4000',
        'https://kachingscanner.com',
        'https://www.kachingscanner.com',
    ],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)
app.include_router(market_data_router)
model = LSTMSignalModel()


class SignalRequest(BaseModel):
    symbol: str
    interval: str = '1h'
    lookback: int = Field(default=200, ge=20, le=5000)


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


@app.get('/health')
def health_check():
    status = market_data_service.status()
    configured = any(provider['configured'] for provider in status['providers'])
    return {
        'status': 'ok' if configured else 'degraded',
        'service': 'python-market-data-ai',
        'market_data': status,
    }


@app.post('/signal', response_model=SignalResponse)
def create_signal(request: SignalRequest):
    try:
        bars, _meta = market_data_service.get_candles(request.symbol, request.interval, request.lookback)
        if bars is None or bars.empty:
            raise HTTPException(status_code=404, detail='Market data unavailable')

        bars['rsi'] = compute_rsi(bars['close'])
        bars['macd'], bars['macd_signal'] = compute_macd(bars['close'])
        bars['bb_upper'], bars['bb_middle'], bars['bb_lower'] = compute_bollinger(bars['close'])

        return generate_signals(request.symbol, bars, model)
    except HTTPException:
        raise
    except MarketDataUnavailableError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
