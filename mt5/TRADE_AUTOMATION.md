# MT5 trade automation (trail + break-even)

Requires **KachingTradeCopier.mq5 v1.14+** compiled and attached in MT5.

> **v1.14:** PairCode is the **only** MT5 auth. LinkToken / manual BackendURL inputs removed.
> **v1.13:** 8-char Pair Codes, multi-device access/refresh tokens, heartbeat (~30s), dashboard device revoke.
> **v1.11:** default `PollSeconds` is **1** (was 3).
> Auth uses the `X-MT5-Token` / `Authorization: Bearer` header only — query-string `?token=` is rejected by the API.

## Pairing (sole auth method)

1. Dashboard **Auto Trading → Pair MT5** creates a cryptographically random **8-character** code from alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no O/0/I/1/L).
2. Codes are stored in **Redis** with TTL **10 minutes** (never in Mongo). Production **requires** Redis; memory fallback is test-only (`NODE_ENV=test` or `MT5_PAIRING_ALLOW_MEMORY=true`).
3. Enter the code in the EA `PairCode` input. EA bootstraps against the built-in default backend URL and calls `POST /api/mt5/pair/complete`.
4. Response: `{ backendUrl, accessToken, refreshToken, deviceId, subscriberId }`. Consumption is atomic (Redis GETDEL); the code is removed only after a successful device registration (restored on failure).
5. EA stores credentials under Common Files `KachingAI_credentials.txt` (never stores the PairCode).
6. Multiple devices per subscriber are supported; revoke one from the dashboard without affecting others.
7. Heartbeat: `POST /api/mt5/bridge/heartbeat` ~every 30s → dashboard shows Connected (Active) / Offline after 90s without heartbeat.
8. Token renewal: `POST /api/mt5/pair/refresh` with refreshToken. Invalid refresh → Connection Lost / Please Pair Again.
9. Access token TTL **24h**, refresh token TTL **90d**.

### Redis key format

| Key | Purpose | TTL |
|-----|---------|-----|
| `kaching:mt5:pair:code:{CODE}` | Pending pair session JSON | 600s |
| `kaching:mt5:pair:user:{userId}` | Latest pending code for user | 600s |
| `kaching:mt5:pair:fail:ip:{ip}` | Failed complete attempts | 10 min |
| `kaching:mt5:pair:fail:code:{CODE}` | Failed attempts per code | 10 min |

### API (auth / devices)

| Method | Path | Who | Notes |
|--------|------|-----|-------|
| `POST` | `/api/mt5/pair/start` | Dashboard (JWT) | Issues PairCode — never returns permanent tokens |
| `POST` | `/api/mt5/pair/complete` | EA | Exchanges PairCode for device tokens + backendUrl |
| `POST` | `/api/mt5/pair/refresh` | EA | Renews access token |
| `GET` | `/api/mt5/devices` | Dashboard | Lists devices (no tokens) |
| `POST` | `/api/mt5/devices/:id/revoke` | Dashboard | Revokes one device |

Legacy `POST /api/mt5/link-token` has been **removed**.

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
