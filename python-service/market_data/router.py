from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .errors import to_user_facing_market_data_error
from .service import MarketDataUnavailableError, market_data_service

router = APIRouter(prefix='/market-data', tags=['Market Data'])


class CandleBar(BaseModel):
    timestamp: str | int | float | None = None
    time: str | int | float | None = None
    open: float
    high: float
    low: float
    close: float
    volume: float = 0


class CandlesInjectRequest(BaseModel):
    symbol: str = Field(..., min_length=3)
    interval: str = '1h'
    limit: int = Field(default=100, ge=1, le=5000)
    candles: list[CandleBar] = Field(..., min_length=1)


@router.get('/status')
def market_data_status():
    return market_data_service.status()


@router.get('/providers')
def market_data_providers():
    """Providers are owned by Node; FastAPI does not call external market APIs."""
    status = market_data_service.status()
    return {
        'mode': status['mode'],
        'external_http_fetch': False,
        'providers': [],
        'note': status['note'],
    }


@router.get('/symbols/{symbol}/candles')
def get_symbol_candles(
    symbol: str,
    interval: str = Query('1h'),
    limit: int = Query(100, ge=1, le=5000),
):
    """Read candles from the shared Node Redis hub cache only (no provider fetch)."""
    try:
        return market_data_service.get_candles_payload(symbol, interval, limit)
    except MarketDataUnavailableError as exc:
        raise HTTPException(
            status_code=404,
            detail=to_user_facing_market_data_error(str(exc)),
        ) from exc


@router.get('/candles')
def get_candles(
    symbol: str = Query(..., min_length=3),
    interval: str = Query('1h'),
    limit: int = Query(100, ge=1, le=5000),
):
    return get_symbol_candles(symbol, interval, limit)


@router.post('/candles')
def post_candles(request: CandlesInjectRequest):
    """Analyze-ready payload from caller-injected bars (Node hub / ChartDataService)."""
    try:
        return market_data_service.get_candles_payload(
            request.symbol,
            request.interval,
            request.limit,
            [c.model_dump() for c in request.candles],
        )
    except MarketDataUnavailableError as exc:
        raise HTTPException(
            status_code=400,
            detail=to_user_facing_market_data_error(str(exc)),
        ) from exc
