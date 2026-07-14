from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from .config import load_settings
from .symbols import to_twelve_data_symbol


class MarketDataStreamManager:
    """Relay Twelve Data WebSocket price updates to FastAPI clients."""

    def __init__(self):
        self.settings = load_settings()
        self.clients: set[WebSocket] = set()
        self.subscriptions: set[str] = set()
        self._upstream_task: asyncio.Task | None = None
        self._lock = asyncio.Lock()

    def _can_stream(self) -> bool:
        return self.settings.stream_enabled and bool(self.settings.twelve_data_api_key)

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.clients.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.clients.discard(websocket)

    async def subscribe(self, symbols: list[str]) -> None:
        normalized = {to_twelve_data_symbol(symbol) for symbol in symbols if symbol}
        async with self._lock:
            self.subscriptions.update(normalized)
            if self._can_stream() and self._upstream_task is None:
                self._upstream_task = asyncio.create_task(self._run_upstream())

    async def broadcast(self, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for client in self.clients:
            try:
                await client.send_json(payload)
            except Exception:
                dead.append(client)
        for client in dead:
            self.disconnect(client)

    async def _run_upstream(self) -> None:
        if not self._can_stream():
            return

        import websockets

        url = f'wss://ws.twelvedata.com/v1/quotes/price?apikey={self.settings.twelve_data_api_key}'
        while self.clients and self.subscriptions:
            try:
                async with websockets.connect(url, ping_interval=20, ping_timeout=20) as upstream:
                    subscribe_msg = {
                        'action': 'subscribe',
                        'params': {'symbols': ','.join(sorted(self.subscriptions))},
                    }
                    await upstream.send(json.dumps(subscribe_msg))

                    async for message in upstream:
                        payload = json.loads(message)
                        event = payload.get('event')
                        if event == 'price':
                            await self.broadcast(
                                {
                                    'type': 'price',
                                    'provider': 'twelve_data',
                                    'symbol': payload.get('symbol'),
                                    'price': payload.get('price'),
                                    'timestamp': payload.get('timestamp'),
                                }
                            )
                        elif event == 'subscribe-status' and payload.get('status') != 'ok':
                            await self.broadcast(
                                {
                                    'type': 'error',
                                    'provider': 'twelve_data',
                                    'message': payload.get('message') or 'Subscription failed',
                                }
                            )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                await self.broadcast({'type': 'error', 'provider': 'twelve_data', 'message': str(exc)})
                await asyncio.sleep(3)

    async def handle_client(self, websocket: WebSocket) -> None:
        await self.connect(websocket)
        try:
            while True:
                message = await websocket.receive_json()
                action = message.get('action')
                if action == 'subscribe':
                    symbols = message.get('symbols') or []
                    if isinstance(symbols, str):
                        symbols = [part.strip() for part in symbols.split(',') if part.strip()]
                    await self.subscribe(symbols)
                    await websocket.send_json({'type': 'subscribed', 'symbols': list(self.subscriptions)})
                elif action == 'ping':
                    await websocket.send_json({'type': 'pong'})
        except WebSocketDisconnect:
            pass
        finally:
            self.disconnect(websocket)


stream_manager = MarketDataStreamManager()
