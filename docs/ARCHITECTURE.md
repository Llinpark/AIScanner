# KachingScanner Architecture

## Decision: TradingView is the sole trading-signal source

**Status:** Accepted (2026-07-24)

Trading signals are produced by TradingView Pine strategies and ingested only via authenticated webhooks:

`TradingView Pine → Webhook → Node → MongoDB / WebSocket / Telegram / MT5 / React Dashboard`

KachingScanner is a **signal distribution** platform. It does not generate trade entries from live market-data providers.

## Decision: Chart feed is fully isolated from signals

**Status:** Accepted (2026-07-24)

`ChartDataService` / `MarketDataHubService` (Twelve Data, EODHD, etc.) exist **only** to render Lightweight Charts candles.

- Chart provider outages must never block webhook ingest, Mongo persistence, Socket.IO fan-out, Telegram, or MT5.
- Dashboard copy on chart failure: signals and alerts continue normally.
- Chart overlay Entry/SL/TP levels come from **stored webhook signal payloads**, not from recalculating indicators on live candles.

## Decision: No live-provider signal generation

**Status:** Accepted (2026-07-24)

The following must not publish production trading signals from provider candles:

- Timer auto-scan (`SCANNER_AUTO_ENABLED` remains `false` in production)
- `POST /api/scanner/run` / `scanSymbol`
- Dashboard `GET /api/scanner/analyze` (no longer used to invent levels)

Legacy pattern-detection helpers may remain for offline math / weight learning but are not a selectable production strategy. Active strategies are Sweep+FVG Day Trading and Scalping only.

## Decision: AI commentary is descriptive, not generative of trades

**Status:** Accepted (2026-07-24)

Dashboard AI content explains a TradingView signal using stored metadata (`strategyName`, `timeframe`, `tradeExplanation`, confidence). It must not claim Kaching generated the entry, and must not recalculate RSI/MACD/etc. for display when values are already stored on the signal.

Optional FastAPI (`kaching-python`) may run analytics on Node-injected candles for research endpoints; it is **not** the trading-signal engine and does not call market providers.

## Decision: WebSocket is event-driven from webhooks

**Status:** Accepted (2026-07-24)

Dashboard signal list updates exclusively from webhook-driven Socket.IO events (`signal:update`, `signal:outcome`, `tv:live-alert`). No polling loop for new signals.
