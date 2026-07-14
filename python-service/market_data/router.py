from fastapi import APIRouter, HTTPException, Query, WebSocket

from .service import MarketDataUnavailableError, market_data_service
from .streaming import stream_manager

router = APIRouter(prefix='/market-data', tags=['Market Data'])


@router.get('/status')
def market_data_status():
    return market_data_service.status()


@router.get('/providers')
def market_data_providers():
    return {
        'primary': market_data_service.settings.primary_provider,
        'fallback': market_data_service.settings.fallback_provider,
        'providers': [provider.status() for provider in market_data_service.providers.values()],
    }


@router.get('/symbols/{symbol}/candles')
def get_symbol_candles(
    symbol: str,
    interval: str = Query('1h'),
    limit: int = Query(100, ge=1, le=5000),
):
    try:
        return market_data_service.get_candles_payload(symbol, interval, limit)
    except MarketDataUnavailableError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get('/candles')
def get_candles(
    symbol: str = Query(..., min_length=3),
    interval: str = Query('1h'),
    limit: int = Query(100, ge=1, le=5000),
):
    return get_symbol_candles(symbol, interval, limit)


@router.websocket('/ws')
async def market_data_ws(websocket: WebSocket):
    await stream_manager.handle_client(websocket)
