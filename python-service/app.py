from datetime import datetime

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from indicators import compute_bollinger, compute_macd, compute_rsi
from market_data import market_data_service
from market_data.errors import CANDLES_REQUIRED_MESSAGE, to_user_facing_market_data_error
from market_data.router import router as market_data_router
from market_data.service import MarketDataUnavailableError
from model import LSTMSignalModel, generate_signals

app = FastAPI(title='KachingScanner AI Analytics Service')
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


class CandleBar(BaseModel):
    timestamp: str | int | float | None = None
    time: str | int | float | None = None
    open: float
    high: float
    low: float
    close: float
    volume: float = 0


class SignalRequest(BaseModel):
    symbol: str
    interval: str = '1h'
    lookback: int = Field(default=200, ge=20, le=5000)
    candles: list[CandleBar] | None = Field(
        default=None,
        description='OHLC bars from Node MarketDataHub / ChartDataService. Required unless Redis hub cache is populated.',
    )


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
    return {
        'status': 'ok',
        'service': 'python-ai-analytics',
        'market_data': status,
    }


@app.post('/signal', response_model=SignalResponse)
def create_signal(request: SignalRequest):
    """Run AI/indicator signal analytics on caller-injected (or Redis-cached) candles.

    Does not fetch from Twelve Data or EODHD.
    """
    try:
        injected = [c.model_dump() for c in request.candles] if request.candles else None
        if not injected:
            # Prefer Redis hub written by Node; still no external HTTP.
            try:
                bars, _meta = market_data_service.resolve_bars(
                    request.symbol, request.interval, request.lookback, None
                )
            except MarketDataUnavailableError as exc:
                raise HTTPException(
                    status_code=400,
                    detail=CANDLES_REQUIRED_MESSAGE,
                ) from exc
        else:
            bars, _meta = market_data_service.resolve_bars(
                request.symbol, request.interval, request.lookback, injected
            )

        if bars is None or bars.empty:
            raise HTTPException(status_code=400, detail=CANDLES_REQUIRED_MESSAGE)

        bars = bars.copy()
        bars['rsi'] = compute_rsi(bars['close'])
        bars['macd'], bars['macd_signal'] = compute_macd(bars['close'])
        bars['bb_upper'], bars['bb_middle'], bars['bb_lower'] = compute_bollinger(bars['close'])

        return generate_signals(request.symbol, bars, model)
    except HTTPException:
        raise
    except MarketDataUnavailableError as exc:
        raise HTTPException(
            status_code=400,
            detail=to_user_facing_market_data_error(str(exc)),
        ) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
