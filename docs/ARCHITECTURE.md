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

- Timer auto-scan (`SCANNER_AUTO_ENABLED` defaults `true` for the admin/internal scanner timer; it must still never publish live-provider candles as TradingView signals)
- `POST /api/scanner/run` / `scanSymbol`
- Dashboard `GET /api/scanner/analyze` (no longer used to invent levels)

Legacy pattern-detection helpers may remain for offline math / weight learning but are not a selectable production strategy. Active strategies are Sweep+FVG Day Trading and Scalping only. TradingView webhooks remain the sole production signal distribution path.

## Decision: AI commentary is descriptive, not generative of trades

**Status:** Accepted (2026-07-24)

Dashboard AI content explains a TradingView signal using stored metadata (`strategyName`, `timeframe`, `tradeExplanation`, confidence). It must not claim Kaching generated the entry, and must not recalculate RSI/MACD/etc. for display when values are already stored on the signal.

Optional FastAPI (`kaching-python`) may run analytics on Node-injected candles for research endpoints; it is **not** the trading-signal engine and does not call market providers.

## Decision: WebSocket is event-driven from webhooks

**Status:** Accepted (2026-07-24)

Dashboard signal list updates exclusively from webhook-driven Socket.IO events (`signal:update`, `signal:outcome`, `tv:live-alert`). No polling loop for new signals.

## Decision: Strategy Configuration is the single source of truth for timeframes

**Status:** Accepted (2026-08-03)

All Entry Timeframe and HTF Confirmation layouts are defined in one canonical module:

`backend/strategies/config/strategyArchitecture.js`

(Frontend mirror: `frontend/src/constants/strategyArchitecture.js`.)

Admin Configuration → Strategy Configuration → Generated Pine. The Pine generator must never hardcode HTF, Entry TF, or TF validation expressions; it injects them from Strategy Configuration. Scanner thresholds (confidence, sessions, liquidity, TP profiles) stay in per-strategy config modules that **consume** the architecture TF allowlists.

### Scalping Architecture

| Role | Timeframes |
|------|------------|
| **Entry Timeframe** | `3m`, `5m` |
| **HTF Confirmation** | `15m` (via `request.security` only) |

- `1m` is **not** a supported Entry Timeframe.
- Never open the 15m chart for entries; never fire entries on HTF candles.

### Day Trading Architecture

| Role | Timeframes |
|------|------------|
| **Entry Timeframe** | `5m`, `15m` |
| **HTF Confirmation** | `1H`, `4H` (via `request.security` only) |

- Default baked HTF is `1H` from Strategy Configuration; advanced users may switch the Pine HTF input to `4H`.
- Never open 1H/4H charts for entries.

### HTF Confirmation & `request.security`

HTF structure/liquidity/bias is fetched with `request.security(..., barmerge.lookahead_off)`. Entries evaluate on the chart Entry Timeframe only. This keeps TradingView as the sole source of truth for trades while preventing HTF-chart mis-attachment.

### No Repainting guarantees

- Confirmed-bar gating (`barstate.isconfirmed`) for hist/rt parity.
- `request.security` uses `lookahead_off`.
- TF validation (`entryChartOk` / `htfTfOk` / `chartIsHtf`) blocks signals on wrong charts and surfaces diagnostic labels instead of silent suppression:
  - Wrong Entry Timeframe
  - Wrong HTF Configuration
  - Chart opened on HTF
  - Unsupported Strategy Configuration
  - Missing HTF Confirmation

### TradingView workflow

1. Choose strategy (Scalping or Day Trading) in the app. Setup defaults to **Day Trading** (5m/15m entries). Scalping is 3m/5m only — a 15m chart correctly locks Scalping because 15m is HTF Confirmation, not entry.
2. Generate personal Pine (HTF default baked from Strategy Configuration). Lock labels include the strategy name (e.g. `Wrong Entry Timeframe (Scalping)`).
3. Attach script to an allowed **Entry Timeframe** chart.
4. Create alert → webhook → Kaching distribution (dashboard / Telegram / MT5).
5. After admin TF/config changes or deploy: regenerate Pine and recreate the alert.

Strategy math (liquidity sweep, FVG, BOS/CHOCH, entry models, confidence, risk/TP/SL) is unchanged by this architecture layer. Future strategies (Swing, Position, Crypto, Gold) register architecture slots without modifying Pine strategy math.

Startup validation (`assertStrategyArchitecturesValid` / `initStrategyRuntimeConfig`) rejects invalid Entry/HTF combinations before Pine generation.
