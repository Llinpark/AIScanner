# Redis Recovery Cost Repair — Pre-Deployment Audit

**Date:** 2026-09-02  
**Scope:** Local audit, validation, tests. **No Fly deploy. No production Redis/Mongo writes. Cleanup script not run against production.**

**Final verdict: SAFE TO DEPLOY**

---

## 1. CURRENT IMPLEMENTATION STATUS

**CONFIRMED.** The Redis Recovery Cost Repair is present in this tree and matches the intended production behaviour.

| Intended behaviour | Actual code |
|---|---|
| Mongo is primary recovery discovery | `utils/durableDelivery.js` `collectDueJobsBounded` (lines 924–989) queries unfinished+due DeliveryJobs with `.limit(budget)` |
| Redis `djobidx` scan OFF by default | `redisIndexScanEnabled()` → `envFlag('DELIVERY_RECOVERY_REDIS_SCAN', false)` (lines 233–235, 994–1002) |
| Interval default 15000 ms | `DEFAULT_RECOVERY_INTERVAL_MS = 15000` (line 82) |
| Floor 5000 ms | `Math.max(getMinRecoveryIntervalMs(), requested)` (lines 224–231) |
| Process budget 8, max 32 | `getProcessBudget()` clamp 1–32 (lines 237–238) |
| Cleanup not started at boot | `server.js` 3004–3011 starts recovery worker only; no `runIndexCleanupPass` |
| Historical 41k members not bulk-deleted | Admin script only; default DRY-RUN |

**CONFIRMED.** Live TradingView fan-out is not gated on the recovery interval. `server.js` starts the worker after listen; `setInterval` is `unref()`’d. Recovery handler uses `waitMode: 'check_once'`; live sequencer default remains 3000 ms.

Minor pre-deploy corrections applied in this audit (not a redesign):

1. `scripts/cleanup-djobidx.js` now requires **both** `--execute` **and** `CONFIRM_DJOBIDX_CLEANUP=YES`.
2. `fly.toml` `[env]` now pins the four required recovery variables (and keeps `EMAIL_TRADE_ALERTS_ENABLED`).
3. Tests now assert `INTERVAL=2000` clamps to 5000, and `REDIS_SCAN=true` vs `0`.

---

## 2. CONFIGURATION AUDIT

**CONFIRMED — repository runtime config**

| Variable | Code default | `.env.example` | `fly.toml [env]` (this audit) | Fly secrets (live list, names only) |
|---|---|---|---|---|
| `DELIVERY_RECOVERY_INTERVAL_MS` | 15000 | 15000 (commented) | **15000** | **not set** |
| `DELIVERY_RECOVERY_MIN_INTERVAL_MS` | 5000 | 5000 (commented) | **5000** | **not set** |
| `DELIVERY_RECOVERY_REDIS_SCAN` | `false` / off | 0 (commented) | **0** | **not set** |
| `DELIVERY_RECOVERY_PROCESS_BUDGET` | 8 | 8 (commented) | **8** | **not set** |

**CONFIRMED.** `DELIVERY_RECOVERY_REDIS_SCAN` cannot accidentally be 1 from repo, Dockerfile, or `fly.toml`. `envFlag` treats only `1` / `true` / `yes` / `on` as enabled. Unset, empty, `0`, `false`, `off` stay off. Unexpected strings fall back to **false**.

**CONFIRMED.** Live Fly secrets (2026-09-02 `flyctl secrets list -a kaching-api`, names only, values not read) do **not** include any `DELIVERY_RECOVERY_*` keys. After deploy, `fly.toml [env]` applies. There is **no** deployed secret `DELIVERY_RECOVERY_INTERVAL_MS=2000` and **no** `DELIVERY_RECOVERY_REDIS_SCAN=1`.

**WARNING.** Historical docs still mention the old interval (not loaded at runtime):

- `DURABLE_DELIVERY_RECOVERY_REPORT.md` line 282
- `FINAL_RELEASE_HARDENING_REPORT.md` line 275
- `FINAL_RELEASE_SAFETY_AUDIT.md` line 390

If an operator later copies those docs into Fly secrets, `INTERVAL=2000` would be clamped to **5000** unless they also set `MIN=2000`. `REDIS_SCAN=true` would re-enable index walking. Do not copy those old docs into production env.

**CONFIRMED.** `Dockerfile` does not set recovery env vars. `CMD` is `server.js` only.

---

## 3. REDIS COMMAND RISK AFTER REPAIR

Idle recovery (no due jobs), per machine — **estimates** except where marked measured.

| Era | Interval | djobidx discovery | Est. GET/day | Est. HSCAN/day |
|---|---|---|---|---|
| Unbounded historical | 2s | HGETALL + GET × ~41k | ~1.78 billion | n/a |
| P0 bounded (pre this repair) | 2s | HSCAN + GET ≤ 32 | ~1.38 million | ≤ ~345,600 |
| **This repair** | **15s** | **Mongo only** | **~0** | **~0** |

**CONFIRMED (measured in tests):** default recovery against a 41,252-member fake index: `hScan=0`, `get=0`.

**CONFIRMED.** No production path calls `hGetAll(keyIndex())` / `HGETALL kaching:trade:djobidx`. Remaining `hGetAll` in `utils/tradeEventStore.js` (lines 333, 364, 567, 613) is per-trade orphan / sequence hashes, **not** `djobidx`.

**WARNING (not the 41k explosion).** `getCounts()` still issues one `HLEN kaching:trade:djobidx` for pipeline diagnostics (`durableDelivery.js` 1773–1785). That is 1 command per status poll, not 32 GETs every 2s.

**WARNING.** After deploy, the ~41k historical members **remain** until the admin cleanup is run deliberately. They no longer generate recovery GET/HSCAN traffic.

**CONFIRMED.** Live job writes still `SET` job JSON and `HSET`/`HDEL` index fields. That is per delivery, not a scan loop.

---

## 4. RECOVERY WORKER VERIFICATION

**CONFIRMED.**

| Requirement | Location | Result |
|---|---|---|
| Default interval 15000 | `durableDelivery.js:82,228-230` | `getRecoveryIntervalMs()` |
| Floor 5000 | `durableDelivery.js:83,224-230` | `Math.max(min, requested)`; test: `2000` → `5000` |
| Process budget 8 | `durableDelivery.js:92,237-238` | default `PROCESS_BUDGET` |
| Max budget 32 | `getProcessBudget` clamp | CONFIRMED |
| Redis scan OFF | `redisIndexScanEnabled` default false | CONFIRMED |
| Overlap skip | `startRecoveryWorker` 2014–2027 | skip + `recoveryOverlapSkips++` + `finally` clears `workerTickInFlight` |
| Circuit | threshold 5, cooldown 30000 | skip Redis scan while open; Mongo path continues |
| Single worker | `server.js:3010` only production start | `startRecoveryWorker` returns if timer already set |
| Interval unref | `durableDelivery.js:2031` | does not pin the event loop |

**CONFIRMED.** `server.js` does not pass `intervalMs`; production uses `getRecoveryIntervalMs()` (floor applied). Tests may pass `intervalMs: 15` and bypass the floor — test-only.

**CONFIRMED.** Redis circuit does not retry HSCAN inside the same tick after failure (`scanIndexPage` returns empty). After 5 failures, later ticks skip Redis scan. Mongo recovery still runs.

---

## 5. LIVE SIGNAL PIPELINE SAFETY

**CONFIRMED.** Not modified in this repair: Telegram APIs, Resend, MT5 execution, `utils/deliveryIdempotency.js`, TradingView Phase-A durability, Redis delivery lease `SET NX`.

**CONFIRMED.** Webhook path (`server.js` ~939 `acceptTradingViewWebhook`) does not `await processDueJobs`. Recovery is background `setInterval`.

**CONFIRMED.** Recovery uses `waitMode: 'check_once'` (`durableDelivery.js` processDueJobs / `TradingViewAlertService.processDurableJob`). Live sequencer default remains 3000 ms (tested).

**CONFIRMED.** Cross-machine duplicate protection remains Redis leases. Overlap guard is process-local only, as specified.

**ASSUMPTION.** A live ENTRY still reaches Telegram/email after deploy has not been observed on production (this audit did not deploy). Local delivery tests passed.

---

## 6. CLEANUP TOOL SAFETY

**CONFIRMED.** `scripts/cleanup-djobidx.js` exists. `server.js` does not run it. `package.json` has no cleanup start script. Dockerfile `CMD` is `server.js`.

**CONFIRMED (after this audit’s correction).** Execute requires **both**:

- `--execute`
- `CONFIRM_DJOBIDX_CLEANUP=YES`

`--execute` without `YES` exits 2, zero deletes. `YES` without `--execute` is DRY-RUN.

**CONFIRMED.** Cleanup uses bounded `HSCAN`, never `HGETALL` of `djobidx`, never `KEYS`, never flush, never `DEL` of the whole index. EXECUTE refuses if Mongo is not connected.

**CONFIRMED.** Deletes only Mongo/durable **terminal** members and **orphans** (missing Mongo **and** missing Redis job JSON). Preserves active, pending, recoverable, and Redis-only unfinished jobs.

---

## 7. TEST RESULTS

**CONFIRMED (measured this audit):**

```
node --test
  services/__tests__/durableDeliveryBoundedRecovery.test.js
  services/__tests__/durableDeliveryIndexCleanup.test.js
  services/__tests__/durableDeliveryRecovery.test.js
  services/__tests__/finalReleaseHardening.test.js
  services/__tests__/telegramTradeAlertDelivery.test.js
  services/__tests__/entryFirstDeliverySequencing.test.js
  services/__tests__/liveEntrySlotRelease.test.js

ℹ tests 129
ℹ pass 129
ℹ fail 0
```

| Requirement | Result |
|---|---|
| 41,252 fake index, default recovery: HSCAN=0 GET=0 | PASS |
| Mongo/durableDocs discovers due jobs without index | PASS |
| Redis scan only when `DELIVERY_RECOVERY_REDIS_SCAN=1` | PASS |
| Default interval 15000 | PASS |
| `INTERVAL=2000` clamped to 5000 | PASS |
| Process-local overlap skip | PASS |
| Redis failure circuit (no HSCAN storm) | PASS |
| Terminal HDEL after durable commit | PASS |
| HDEL failure does not revert terminal state | PASS |
| Cleanup DRY-RUN: zero HDEL | PASS |
| Cleanup EXECUTE: terminal/orphan only; active + Redis-only pending preserved | PASS |
| Telegram / sequencing / TP-SL / hardening | PASS |

Full `npm test` was previously 862 pass / 4 fail / 2 skipped; the 4 fails are the known `mt5Pairing` / `mt5ReliabilityHardening` parallel `dev-users.json` flake, unrelated to this repair. Not re-run in this audit session.

---

## 8. PRODUCTION DEPLOYMENT CHECKLIST

Do **not** run cleanup during this deploy.

1. Deploy this backend image/tree to Fly `kaching-api` (this task does not deploy).
2. Confirm `fly.toml` `[env]` ships with:
   - `DELIVERY_RECOVERY_INTERVAL_MS=15000`
   - `DELIVERY_RECOVERY_MIN_INTERVAL_MS=5000`
   - `DELIVERY_RECOVERY_REDIS_SCAN=0`
   - `DELIVERY_RECOVERY_PROCESS_BUDGET=8`
3. Do **not** add those as Fly secrets unless they match the values above (secrets override `fly.toml`).
4. After machines start, logs should contain:
   `[DurableDelivery] recovery worker started intervalMs=15000 redisIndexScan=off processBudget=8`
5. Confirm a live TradingView ENTRY still reaches Telegram/email (webhook path).
6. Optionally watch `[DurableDelivery] recovery metrics` (~60s): `hscan=0` `redisScan=off`.
7. **Later, separately:** dry-run then bounded execute of `scripts/cleanup-djobidx.js` against production. Not part of this deploy.

Rollback: revert the release. Do not flush Redis. Newly terminal jobs may already be `HDEL`’d from `djobidx`; rollback will `HSET` on the next non-terminal write.

---

## 9. FLY.IO ENVIRONMENT VARIABLES TO VERIFY

Required after deploy (now in `fly.toml`; **not** currently in Fly secrets):

```
DELIVERY_RECOVERY_INTERVAL_MS=15000
DELIVERY_RECOVERY_MIN_INTERVAL_MS=5000
DELIVERY_RECOVERY_REDIS_SCAN=0
DELIVERY_RECOVERY_PROCESS_BUDGET=8
```

Optional (code defaults already match):

```
DELIVERY_RECOVERY_REDIS_FAIL_THRESHOLD=5
DELIVERY_RECOVERY_REDIS_COOLDOWN_MS=30000
```

**Do not set:**

```
DELIVERY_RECOVERY_REDIS_SCAN=1
DELIVERY_RECOVERY_REDIS_SCAN=true
DELIVERY_RECOVERY_INTERVAL_MS=2000
```

**CONFIRMED.** Live secrets list has no `DELIVERY_RECOVERY_*` entries. No secret update is required for this deploy.

---

## 10. BLOCKERS OR RISKS FOUND

| Item | Label | Action |
|---|---|---|
| Repair implemented; Mongo-primary; scan off | CONFIRMED | Deploy |
| Fly secrets do not override with 2000 or REDIS_SCAN=1 | CONFIRMED | None |
| Cleanup not auto-started | CONFIRMED | None |
| No HGETALL(djobidx) | CONFIRMED | None |
| ~41k historical index members remain until later cleanup | WARNING | Post-deploy admin dry-run; do not `DEL` the key |
| `getCounts` still `HLEN`s the index | WARNING | Diagnostics only; leave |
| Old reports still document 2000 ms | WARNING | Do not copy into Fly env |
| Live production webhook not exercised in this audit | ASSUMPTION | Smoke-test one ENTRY after deploy |
| Operator can later set `REDIS_SCAN=true` | WARNING | Never enable in production unless Mongo recovery is proven broken |
| `DELIVERY_RECOVERY_MIN_INTERVAL_MS=1` would allow 1 ms ticks | WARNING | `fly.toml` pins 5000; do not lower |

No blocker that prevents deploy of this repair.

---

## 11. FINAL DEPLOYMENT VERDICT

**SAFE TO DEPLOY**

The repair is in the codebase, tests for recovery cost, cleanup safety, Telegram, email sequencing, and entry-first/TP-SL paths passed (129/129). Fly secrets do not contain old recovery overrides. `fly.toml` now pins the intended env. Cleanup will not run at startup.

Do not run `scripts/cleanup-djobidx.js` against production as part of this deploy. Do not flush Redis. Do not `DEL kaching:trade:djobidx`.
