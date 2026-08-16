from datetime import datetime
import os
import secrets

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from indicators import compute_bollinger, compute_macd, compute_rsi
from market_data import market_data_service
from market_data.errors import CANDLES_REQUIRED_MESSAGE, to_user_facing_market_data_error
from market_data.router import router as market_data_router
from market_data.service import MarketDataUnavailableError
from model import LSTMSignalModel, generate_signals

app = FastAPI(title='KachingScanner AI Analytics Service')
_default_cors = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4000',
    'https://kachingscanner.com',
    'https://www.kachingscanner.com',
    'https://api.kachingscanner.com',
]
_extra_cors = [o.strip() for o in os.getenv('CORS_ORIGINS', '').split(',') if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[*_default_cors, *_extra_cors],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'],
)

# Shared secret with Node PythonAiService — reject unauthenticated /signal (and other) calls.
PYTHON_SERVICE_API_KEY = (os.getenv('PYTHON_SERVICE_API_KEY') or '').strip()
_PUBLIC_PATHS = {'/health', '/docs', '/openapi.json', '/redoc'}


@app.middleware('http')
async def require_python_api_key(request: Request, call_next):
    path = request.url.path
    if path in _PUBLIC_PATHS or path.startswith('/docs') or path.startswith('/redoc'):
        return await call_next(request)

    if not PYTHON_SERVICE_API_KEY:
        # Local/dev without a key stays open; production must set PYTHON_SERVICE_API_KEY.
        if (os.getenv('REQUIRE_PYTHON_API_KEY') or '').lower() == 'true':
            return JSONResponse(status_code=503, content={'detail': 'API key not configured'})
        return await call_next(request)

    provided = (
        request.headers.get('x-api-key')
        or request.headers.get('x-kaching-python-key')
        or ''
    ).strip()
    # compare_digest requires equal-length strings
    if (
        not provided
        or len(provided) != len(PYTHON_SERVICE_API_KEY)
        or not secrets.compare_digest(provided, PYTHON_SERVICE_API_KEY)
    ):
        return JSONResponse(status_code=401, content={'detail': 'Unauthorized'})
    return await call_next(request)


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
    # Minimal public health — no Redis/cache/provider leakage.
    return {
        'status': 'ok',
        'service': 'python-ai-analytics',
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
