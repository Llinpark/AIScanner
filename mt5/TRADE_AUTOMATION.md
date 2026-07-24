# MT5 trade automation (trail + break-even)

Requires **KachingTradeCopier.mq5 v1.11+** compiled and attached in MT5.

> **v1.11:** default `PollSeconds` is **1** (was 3). Recompile and re-attach the EA after upgrading.
> Auth uses the `X-MT5-Token` header only — query-string `?token=` is rejected by the API.

## Bridge payload fields (set by backend)

| Field | Meaning |
|-------|---------|
| `trailingStop` | Pro+: enable trail after fill |
| `trailDistancePips` | Distance from price to SL (default = initial SL distance in pips) |
| `trailStepPips` | Min improvement before SL moves again (default = 20% of trail distance) |
| `breakEven` | Pro+: enable break-even |
| `breakEvenTriggerR` | Move SL when price is N× initial R (default `1`) |
| `breakEvenOffsetPips` | Lock SL at entry ± this many pips (default `2`, covers spread) |

## Runtime

1. EA polls `/api/mt5/bridge/pending`, places the deal with entry SL/TP1.
2. If trail and/or BE flags are true, the position is registered for management.
3. On every tick (and timer), the EA:
   - **Break-even**: when favorable move ≥ `triggerR × |entry−SL|`, sets SL to entry ± offset.
   - **Trailing**: keeps SL `trailDistance` behind price; only tightens when gain ≥ `trailStep`.

## Symbol mapping

Backend `toMt5Symbol()` maps known catalog names (e.g. `XAU/USD` → `XAUUSD`) and **pass-through** any other TradingView symbol (stocks, indices, crypto) after stripping slashes. Append your broker suffix in the dashboard (`symbolSuffix`, e.g. `.m`, `.i`, `m`).

If the EA logs `Symbol not found in Market Watch`, enable that exact name in MT5 Market Watch or adjust the suffix — the queue is not refused for “unknown forex pair”.

## Auto lot sizing

- **Premium** (`autoLotSizing`): lot = risk% × synced MT5 balance (via SyncAccount). Queue fails until balance syncs.
- **Pro**: fixed lot from dashboard (`fixedLotSize`, default `0.01`).
