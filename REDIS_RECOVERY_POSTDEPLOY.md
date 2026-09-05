# Redis Recovery Cost Repair — Post-Deployment Report

**Date:** 2026-09-02  
**App:** `kaching-api` (Fly.io, region `ams`)  
**Release:** **v154**  
**Image:** `registry.fly.io/kaching-api:deployment-01M1GRDJ6AG2KSGZ5CZG7E4519`

**Final verdict: DEPLOYMENT SUCCESSFUL — MONITORING REQUIRED**

Cleanup of `kaching:trade:djobidx` was **not** run. Redis was **not** flushed. `DELIVERY_RECOVERY_REDIS_SCAN` remains **0**.

---

## 1. DEPLOYMENT STATUS

**CONFIRMED.** Classic remote builder deploy completed successfully.

- Command: `flyctl deploy -a kaching-api -c fly.toml --ha=false --remote-only --depot=false --yes`
- Exit code: **0**
- Elapsed: ~12 minutes (slow Docker context upload, then build/push/rolling replace)
- Both existing machines updated with rolling strategy (`--ha=false`; no extra machines created)
- Public URL: https://kaching-api.fly.dev/

Earlier Depot / local-Docker attempts failed; this classic remote-builder run is the one that shipped.

---

## 2. GIT / RELEASE STATUS

**WARNING.** This working directory is **not a git repository**. Deploy was from the local tree via `fly.toml` + `Dockerfile`, not from a git SHA.

**CONFIRMED.** Fly release **v154** is complete (~2 minutes after deploy finish). Previous known-good release remains **v153**:

- v154 (this repair): `registry.fly.io/kaching-api:deployment-01M1GRDJ6AG2KSGZ5CZG7E4519`
- v153 (rollback target): `registry.fly.io/kaching-api:deployment-01M1F106J14WQB4Y8F2P48KZQC`

---

## 3. FLY.IO DEPLOYMENT STATUS

**CONFIRMED.**

| Machine | Name | Version | State | Checks | Image |
|---|---|---|---|---|---|
| `d8d452ea420dd8` | crimson-wind-1485 | **154** | started | 1/1 passing | `deployment-01M1GRDJ6AG2KSGZ5CZG7E4519` |
| `683d1292f2d948` | quiet-wind-6291 | **154** | started | 1/1 passing | `deployment-01M1GRDJ6AG2KSGZ5CZG7E4519` |

Each machine has a single start event at deploy time. **No restart loop.**

**WARNING.** During the first machine replace, Fly briefly logged that nothing was listening on `0.0.0.0:8080` (only `hallpass`). Smoke checks then passed. Subsequent HTTP health checks are passing.

---

## 4. PRODUCTION CONFIGURATION CONFIRMED

**CONFIRMED** from `flyctl config env -a kaching-api` and in-machine `printenv` on `d8d452ea420dd8`:

```
DELIVERY_RECOVERY_INTERVAL_MS=15000
DELIVERY_RECOVERY_MIN_INTERVAL_MS=5000
DELIVERY_RECOVERY_REDIS_SCAN=0
DELIVERY_RECOVERY_PROCESS_BUDGET=8
HOST=0.0.0.0
PORT=8080
NODE_ENV=production
EMAIL_TRADE_ALERTS_ENABLED=true
```

**CONFIRMED.** Fly secrets list still has **no** `DELIVERY_RECOVERY_*` keys, so `fly.toml [env]` is what the machines run.

---

## 5. RECOVERY WORKER STATUS

The exact boot line `[DurableDelivery] recovery worker started intervalMs=15000 redisIndexScan=off` was **not** in the retained `flyctl logs --no-tail` window (startup already scrolled out). Live metrics on **both** machines prove the worker is running with the intended config.

Observed (UTC):

```
2026-09-02T10:03:37Z d8d452ea420dd8
[DurableDelivery] recovery metrics | ticks=10 overlapSkips=0 hscan=0 hydrates=0 gets=0
discovered=72 recovered=72 terminalSkipped=0 indexRemoved=24 lastDurationMs=211
redisFails=0 circuit=closed redisScan=off intervalMs=15000

2026-09-02T10:04:49Z 683d1292f2d948
[DurableDelivery] recovery metrics | ticks=13 overlapSkips=0 hscan=0 hydrates=0 gets=0
discovered=96 recovered=96 terminalSkipped=0 indexRemoved=10 lastDurationMs=165
redisFails=0 circuit=closed redisScan=off intervalMs=15000

2026-09-02T10:04:52Z d8d452ea420dd8
[DurableDelivery] recovery metrics | ticks=15 overlapSkips=0 hscan=0 hydrates=0 gets=0
discovered=112 recovered=112 terminalSkipped=0 indexRemoved=36 lastDurationMs=167
redisFails=0 circuit=closed redisScan=off intervalMs=15000
```

| Check | Result |
|---|---|
| Actual recovery interval | **CONFIRMED 15000 ms** (`intervalMs=15000`; tick rate ≈ 14.5s from boot) |
| Redis index scan | **CONFIRMED off** (`redisScan=off`) |
| MongoDB recovery | **CONFIRMED running** (`discovered`/`recovered` increasing; due jobs processed) |
| HSCAN of `djobidx` | **CONFIRMED 0** (`hscan=0`) |
| Hydration GET from index | **CONFIRMED 0** (`hydrates=0`, `gets=0`) |
| Overlap / circuit | **CONFIRMED** `overlapSkips=0`, `circuit=closed`, `redisFails=0` |
| Tick duration | **CONFIRMED** ~165–211 ms on 512MB VMs (not OOM-scale) |

**STOP conditions not met:** scan is not `on`; interval is not 2000 or below 5000.

Logs also show Mongo recovery marking old due jobs `FAILED_TERMINAL` / `DUPLICATE SUPPRESSED` / `RETRY_SCHEDULED` (including `rehydrate_error` on stale jobs). That is Mongo-primary recovery of historical unfinished work, **not** a Redis index walk. Best-effort `HDEL` after terminal commit is incrementing `indexRemoved` (expected; not the admin cleanup script).

---

## 6. APPLICATION HEALTH STATUS

| Check | Label | Evidence |
|---|---|---|
| App starts | **CONFIRMED** | Both machines `started` after rolling replace |
| API reachable | **CONFIRMED** | Fly HTTP check `GET /api/health` passing on both machines |
| License crypto | **CONFIRMED** | `"licenseTokenCrypto":"ok"` |
| MongoDB | **CONFIRMED** | Recovery discovers and processes DeliveryJobs every tick |
| Redis (configured) | **CONFIRMED** | `"redisConfigured":true`; `indexRemoved` increases via `HDEL` |
| Redis (health snapshot) | **WARNING** | `/api/health` reports `"redisConnected":false` and null last-success fields. Health does not ping Redis. No `lastRedisErrorCode`. Recovery `redisFails=0`. Treat as diagnostic lag, not a proven outage. |
| Recovery worker | **CONFIRMED** | Metrics on both machines |
| Redis `djobidx` scan | **CONFIRMED OFF** | `redisScan=off`, `hscan=0` |
| Repeated recovery errors | **WARNING** | Historical jobs log `rehydrate_error` then terminal/retry. Not a crash loop. |
| Redis reconnect storm | **CONFIRMED none observed** | `redisFails=0`, circuit closed |
| Memory | **CONFIRMED normal from logs** | Tick ~165–211 ms; no OOM in sampled logs. 512MB VMs unchanged. |
| Restart loop | **CONFIRMED none** | One start event per machine at deploy |

---

## 7. REDIS COMMAND RISK STATUS

**CONFIRMED from production logs:** continuous recovery-index traffic is **not** running.

- No `HSCAN` of `kaching:trade:djobidx` (`hscan=0` on both machines)
- No index hydration `GET` (`hydrates=0`, `gets=0`)
- No `HGETALL(djobidx)` observed
- No command storm / recovery tight-loop (`intervalMs=15000`, tick duration &lt; 220 ms)
- Remaining Redis use is live-path / best-effort `HDEL` of members that Mongo just marked terminal (`indexRemoved`)

Upstash dollar cost was **not** measured in this window. Historical ~41k index members remain until a later admin cleanup.

---

## 8. LIVE SIGNAL PIPELINE STATUS

**NOT YET VERIFIED IN LIVE PRODUCTION** for Telegram, Resend email, dashboard Socket.IO, or MT5 fan-out of an accepted ENTRY.

Genuine TradingView webhooks **did** hit both v154 machines immediately after deploy (example `VOLATILITY_90_1S_INDEX` at `2026-09-02T10:03:01Z`). They were **rejected at auth** (`invalid_license_token`, HTTP 401). License diagnostics showed `hasCR=true hasSpace=true` on the presented token. That is **not** a successful live delivery, and it is **not** evidence that recovery is blocking the webhook path.

No fabricated signals were sent.

Webhook ingest on the new release is reachable. Successful persist → DurableDelivery → Telegram / email / MT5 of a **valid** ENTRY was **not** observed in this window.

---

## 9. WARNINGS OR RISKS

1. **WARNING.** Fly health JSON `redisConnected=false` should be watched; recovery `HDEL` success argues Redis is usable.
2. **WARNING.** Historical unfinished DeliveryJobs are still being recovered from Mongo (`discovered` climbing). Expected after years of index/job backlog; tick time stays low.
3. **WARNING.** Live ENTRY fan-out not confirmed; current TV posts are 401 on license tokens with CR/space.
4. **WARNING.** First-machine boot warning (not listening on 8080 yet) was transient; health later passed.
5. **WARNING.** ~41k `djobidx` members still exist. Do not `DEL` the key. Cleanup is a later operation.
6. **WARNING.** This folder has no git remote/SHA for the release; rollback is by Fly image v153, not by git revert.

---

## 10. REDIS CLEANUP STATUS

**NOT STARTED**

`scripts/cleanup-djobidx.js` was not run. `CONFIRM_DJOBIDX_CLEANUP=YES` was not set. Redis was not flushed. The whole `kaching:trade:djobidx` key was not deleted.

---

## 11. ROLLBACK STATUS

**NOT PERFORMED.** No critical failure of the Redis recovery repair was observed.

If rollback is needed later, use Fly release **v153**:

`registry.fly.io/kaching-api:deployment-01M1F106J14WQB4Y8F2P48KZQC`

Do not flush Redis during rollback. Terminal jobs already `HDEL`’d from `djobidx` stay removed; that is expected.

---

## 12. FINAL VERDICT

**DEPLOYMENT SUCCESSFUL — MONITORING REQUIRED**
