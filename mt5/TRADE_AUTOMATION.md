# MT5 trade automation (EA full trade manager)

Requires **KachingTradeCopier.mq5 v1.22+** compiled and attached in MT5.

> **v1.22:** Idempotent broker ops — broker is source of truth. Before OrderSend/Modify: validate Expected vs live volume/SL/history; if already done → sync local + report if needed (no resend). Reconciler on OnInit / reconnect / token refresh / every **60s**. Structured TX `sync` vs `execute`. Poll still **1s**.
> **v1.21:** Production hardening — transactional TP/BE/trail flags (broker confirm first), partial/BE retry backoff (2→5→10→20→60s), durable event queue + UUID ack, heartbeat-aware reclaim, recovery flag repair, structured TX logs. Poll still **1s**.
> **v1.20:** EA is the complete trade manager after ENTRY (local TP1/2/3, partials, BE, trailing, recovery, broker filling detect, auto symbol map, management reporting). Backend sends **entry signals only**.
> **v1.14:** PairCode is the **only** MT5 auth. LinkToken / manual BackendURL inputs removed.
> **v1.13:** 8-char Pair Codes, multi-device access/refresh tokens, heartbeat (~30s), dashboard device revoke.
> **v1.11:** default `PollSeconds` is **1** (was 3).
> Auth uses the `X-MT5-Token` / `Authorization: Bearer` header only — query-string `?token=` is rejected by the API.

---

## Subscription execution modes (only two)

`user.mt5.executionMode` has **only** two values:

| Value | Plan | How the trade reaches MT5 |
|-------|------|---------------------------|
| `manual` | **Pro** (default) | Telegram path (see telegramMode below) |
| `auto` | **Premium** (default) | Immediate MT5 queue |

**Identical after MT5 queue:** one EA trade-management engine. No duplicated MT5 logic per plan.

### Pro Telegram preference (`user.telegram.telegramMode`)

This is **not** a third execution mode. It only changes Telegram behaviour while `executionMode === manual`.

| telegramMode | Behaviour |
|--------------|-----------|
| `manual_confirmation` (default; missing field) | Telegram **Execute** / **Ignore** → Execute queues MT5 |
| `alerts_only` | Professional Telegram alert only → **done** (no MT5 queue, no Execute/Ignore) |

Premium ignores `telegramMode` and always uses `executionMode === auto`.

### Pro — Alerts Only (`telegramMode = alerts_only`)

1. Entry signal validated and delivered.
2. Telegram alert (levels + Signal ID + Open Kaching Dashboard). Footer: Manual Trading.
3. **No Execute / Ignore.** No Pair Code required.
4. Subscriber trades manually on any platform.
5. Signal History / Journal shows **Manual (Telegram Alert)**.
6. Does **not** require MT5, EA, Pairing, WebRequest, or Algo Trading.

Switch Telegram Behaviour back to **Manual Confirmation** to show Pair MT5 again.

### Pro — Manual Confirmation (`telegramMode = manual_confirmation`)

1. Entry signal validated and delivered.
2. Telegram shows **Execute Trade** and **Ignore Trade**.
3. Confirmation window: **2–5 minutes** (default **3 min**).
4. **Execute** → MT5 queue → EA. **Ignore** / timeout → not queued.
5. Requires MT5 pairing.

### Premium — Automatic

1. Entry signal validated → `deliverMt5Auto` queues immediately.
2. Telegram (if linked) is **informational only**.
3. EA poll → fill → **same** full management as Pro.

---

## Architecture (post-queue)

```
TradingView ENTRY
       │
       ▼
  Backend validate
       │
       ├─ Premium (executionMode=auto) ───► MT5 queue
       │
       └─ Pro (executionMode=manual)
              │
              ├─ telegramMode=alerts_only ─► Telegram alert (no queue)
              │
              └─ telegramMode=manual_confirmation
                     │
                     ├─ Execute (within TTL) ───► MT5 queue
                     ├─ Ignore ────────────────► discarded
                     └─ Timeout ───────────────► Expired (no queue)
                              │
                              ▼
                     EA poll / OrderSend / trade manager
```

---

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

---

## Bridge payload (ENTRY only)

Backend queues: Signal ID, Symbol, Direction, Entry, SL, TP1, TP2, TP3, Risk, lot, magic (EA input), plus legacy trail/BE hint flags for older EAs.

| Field | Meaning |
|-------|---------|
| `signalId` | Stable signal id (duplicate protection) |
| `mt5Symbol` / `symbol` | Mapped symbol (EA also auto-maps broker variants) |
| `direction` | `buy` / `sell` |
| `entry`, `stopLoss`, `takeProfit1..3` | Levels — EA stores TPs locally |
| `lotSize`, `riskPercent` | Sizing from dashboard/tier |
| `trailingStop`, `breakEven`, … | Legacy Pro+ hints (v1.20 EA prefers its own inputs) |

---

## EA trade management (v1.22)

### Idempotent validation (broker = source of truth)

Before every Partial / BE / Trail broker call:

1. **Validate** Expected vs Broker (live volume, SL, deal history when available)  
2. **Already complete?** → **sync** local flags, persist (on change), report if needed — **no** OrderSend/Modify  
3. **Else** → **execute** broker op → flags → persist → report → chart  

Safe retries always re-validate first (reject race / restart / duplicate path).

### Transaction order (execute path)

For every broker op that still needs a send:

1. **Attempt** broker call  
2. **Broker success** (`TRADE_RETCODE_DONE` / partial / placed)  
3. **Flags** (TP1/2/3, BE, trail)  
4. **Persist** managed file (only on state change)  
5. **Report** (durable queue → POST)  
6. **Chart** panel update  

Never mark TP/BE/trail complete before broker confirms (or validate proves broker already matches).

### Partials + retry

- `EnablePartialClose` + presets: Conservative **25/25/50**, Balanced **40/30/30** (default), Aggressive **50/30/20**, or Custom (must sum **100%**).
- On partial reject: do **not** mark TP complete; retry while price still beyond TP with backoff **2s → 5s → 10s → 20s → 60s**.
- Panel shows `RETRY(tp1#N)` (etc.) while retrying.
- If partials disabled → full close at TP3 only.

### Break-even

Modes: Disabled · at TP1 · after X pips · after X ATR · after X% of target.  
Offset: Entry / +1 / +2 / +5 pips.  
`breakEvenDone` only after successful SL modify (or SL already better). Failed modify → same backoff retry.

### Trailing

Modes: Fixed pips · ATR · Swing H/L · Market Structure · Step.  
Start: Immediately · After TP1 · After TP2.  
Trail reported only after successful SL modify.

### Recovery + reconciler

- Managed state: Common Files `KachingAI_managed_trades.txt`
- Event queue: Common Files `KachingAI_event_queue.dat` (persist **before** POST; keep on failure)
- **Never file-only:** restore only when live position exists; repair from **file + live volume/SL + history OUT deals**
- Reconciler runs: **OnInit**, heartbeat reconnect, token refresh, every **60s** (does not change poll rate)
- Detects TP1/2/BE/trail already done on broker; clears stale pending retries; persists only on change

### Duplicate protection

Signal ID, Magic, Comment (`Kaching#{executionId}`), existing position/ticket — hedging + netting aware.

### Broker compatibility

Detects broker/server/account/type/digits/point/contract/min/max/step/spread.  
Filling mode auto: **IOC → FOK → RETURN** (never hard-coded FOK-only). Retry alternate filling on reject.

### Auto symbol mapping

Enumerates symbols; maps EURUSD variants, XAUUSD/GOLD, US30/DJ30, etc. Optional `SymbolSuffixOverride` / dashboard suffix. Failure → **Unsupported Symbol** report.

### Chart panel

Connection color tags, broker/server/account/balance/equity/version/poll/heartbeat, managed trade progress (TP/BE/TR/RETRY).

### Reporting (`POST /api/mt5/bridge/report`)

Backward compatible `{ executionId, status, ticket, fillPrice, … }`.  
Additive: `event`, `eventUuid`.  
Response: `{ ok, acknowledged, eventUuid, duplicate, execution }`.  
EA removes queued event only on **HTTP 200 + acknowledged=true**. Backend dedupes by `eventUuid`.  
Events: `opened` · `tp1_hit` · `tp2_hit` · `tp3_hit` · `break_even` · `trailing` · `partial_close` · `sl_hit` · `closed`.

### Claim safety (heartbeat-aware)

Pending → `sent` on poll (first-claimer) with `claimedByDeviceId`.  
Stuck `sent` **without ticket** after **120s**:
- If claimer **heartbeat alive** → **wait** (healthy slow EA)
- If claimer heartbeat **missing/offline** → reclaim to `pending`  
Ticketed/filled never reclaimed.

### Structured TX logs

Experts log lines: `TX ts=… sig=… ticket=… broker=… op=… result=… error=… retry=… recovery=…` for OrderSend, Modify SL, Partial, Trail, BE, Report.  
Idempotent decisions use `result=sync` (skipped — broker already matched) or `result=execute` / `ok`, with `recovery=idempotent` / `reconcile`.

---

## Symbol mapping (backend + EA)

Backend `toMt5Symbol()` maps catalog names and aliases (GOLD→XAUUSD, DJ30→US30, …) then optional dashboard `symbolSuffix`.  
EA `ResolveBrokerSymbol()` further matches Market Watch variants. Prefer auto-map; suffix is optional override.

---

## Auto lot sizing

- **Premium** (`autoLotSizing`): lot = risk% × synced MT5 balance (via SyncAccount). Queue fails until balance syncs.
- **Pro**: fixed lot from dashboard (`fixedLotSize`, default `0.01`).

---

## Safety / failure modes

| Failure | Behavior |
|---------|----------|
| MT5 / Windows restart | Reload managed + event queue; reconcile flags; resume |
| Internet blip | Event queue kept; POST retry; tokens refresh |
| Partial / BE reject | No flag; backoff retry while condition holds; next attempt **validates first** (sync if broker already done) |
| Restart mid-TP | Reconcile file+live+history; no duplicate partial/BE/trail |
| Claim without fill | Reclaim after 120s **only if** claimer heartbeat dead |
| Confirm timeout (Pro) | Expired — no queue |
| Unsupported symbol | Report failed; no deal |
| Filling reject | Retry alternate mode |
| Duplicate signal | Skip second fill |
| Duplicate eventUuid | Acked; managementState not re-applied |

---

## Manual testing checklist

### Pro Manual Confirmation

- [ ] Entry → Telegram shows Execute Trade + Ignore Trade + TTL copy
- [ ] Execute within window → TradeExecution pending/sent → EA fills → management reports TP/BE/trail
- [ ] Ignore → ignored; no TradeExecution queue
- [ ] Wait past TTL → Expired; Execute tap refused; no queue
- [ ] After Execute, no further Telegram required for TPs

### Premium Automatic

- [ ] Entry → immediate queue (no Execute buttons on Telegram)
- [ ] Telegram (if linked) informational only
- [ ] Same EA management path as Pro after fill

### Shared EA

- [ ] Partials 40/30/30; BE at TP1; trail after TP1
- [ ] Rejected partial does **not** mark TP; panel shows RETRY; succeeds on backoff
- [ ] BE flag only after SL modify success
- [ ] Kill network mid-report → event stays in `KachingAI_event_queue.dat`; retries after reconnect
- [ ] Restart MT5 mid-trade → managed + queue restored; flags reconciled from broker (not file-only)
- [ ] Partial already done on broker → EA syncs TP flag, **no** second OrderSend (`result=sync`)
- [ ] BE/trail SL already better → skip modify, sync local
- [ ] Slow OrderSend (>120s) with live heartbeat → claim **not** reclaimed
- [ ] Dead EA (no heartbeat) + stuck claim → reclaimed for other/same device
- [ ] Broker IOC/FOK/RETURN works
- [ ] GOLD / US30 symbol variants resolve
- [ ] Poll ~1s; heartbeat ~30s; reconcile ~60s; PairCode multi-device intact

---

## Production deployment checklist

- [ ] Deploy backend with TradeExecution `managementState.ackedEventUuids`, `claimedByDeviceId`, report `{acknowledged,eventUuid}`
- [ ] Set `MT5_MANUAL_CONFIRM_SECONDS` (optional, 120–300)
- [ ] Redis required for PairCode in production
- [ ] Compile & distribute **EA v1.22+**; users re-attach
- [ ] WebRequest allowlist includes API host
- [ ] Verify Pro confirm expiry job starts with server
- [ ] Smoke: Pro expire path + Premium auto queue + TP reject retry + event ack + reclaim+heartbeat
