# Redis Recovery Cost Repair — Post-Deployment Report

**Date:** 2026-09-02  
**App:** `kaching-api` (Fly.io, region `ams`)  
**Working directory:** `C:\TEMP\kaching-v146-correlation-repair`  
**Cleanup script:** not run  
**Redis:** not flushed; `DELIVERY_RECOVERY_REDIS_SCAN` not enabled  

**Final verdict: DEPLOYMENT SUCCESSFUL — CRITICAL VERIFICATION PENDING**

---

## 1. DEPLOYMENT STATUS

**CONFIRMED.** The Redis Recovery Cost Repair is live on production as Fly **version 154**.

Successful command (fourth attempt; earlier Depot / local-Docker attempts failed and were not left running):

```
flyctl deploy -a kaching-api -c fly.toml --ha=false --remote-only --depot=false --yes
```

- Deploy process exit code **0** at `2026-09-02T10:02:05Z`
- Image: `registry.fly.io/kaching-api:deployment-01M1GRDJ6AG2KSGZ5CZG7E4519` (315 MB)
- Rolling update of both machines completed; DNS verified
- No competing deploy was started while this one was running
- Redis was not flushed. `scripts/cleanup-djobidx.js` was not run. `REDIS_SCAN` was not enabled.

Build was slow because the remote builder uploaded a large Docker context (`frontend/` is not in `.dockerignore`). That was upload delay, not an application hang.

---

## 2. GIT / RELEASE STATUS

**CONFIRMED.** This working tree is **not a git repository**. There is no git SHA for this release.

Release identity is the Fly image tag / deployment id:

| Item | Value |
|---|---|
| New image | `registry.fly.io/kaching-api:deployment-01M1GRDJ6AG2KSGZ5CZG7E4519` |
| New app version | **154** |
| Previous / rollback image | `registry.fly.io/kaching-api:deployment-01M1F106J14WQB4Y8F2P48KZQC` |
| Previous version | **153** |

---

## 3. FLY.IO DEPLOYMENT STATUS

**CONFIRMED.** `flyctl status -a kaching-api` after deploy:

| Machine | Version | Region | State | Health |
|---|---|---|---|---|
| `683d1292f2d948` | 154 | ams | started | 1/1 passing |
| `d8d452ea420dd8` | 154 | ams | started | 1/1 passing |

Both machines run image `kaching-api:deployment-01M1GRDJ6AG2KSGZ5CZG7E4519`.

Machine events show a single start each after the rolling replace (`d8d452ea420dd8` at `10:01:15Z`, `683d1292f2d948` at `10:01:42Z`). **No restart loop.** During the first machine’s boot Fly printed a transient “not listening on 0.0.0.0:8080” warning before Node bound the port; smoke checks then passed.

URL: https://kaching-api.fly.dev/

---

## 4. PRODUCTION CONFIGURATION CONFIRMED

**CONFIRMED** from `flyctl config show -a kaching-api` and from live process env (`flyctl ssh console` `printenv` on `683d1292f2d948`):

| Variable | fly.toml / Fly config | Live process env |
|---|---|---|
| `DELIVERY_RECOVERY_INTERVAL_MS` | `15000` | `15000` |
| `DELIVERY_RECOVERY_MIN_INTERVAL_MS` | `5000` | `5000` |
| `DELIVERY_RECOVERY_REDIS_SCAN` | `0` | `0` |
| `DELIVERY_RECOVERY_PROCESS_BUDGET` | `8` | `8` |
| `EMAIL_TRADE_ALERTS_ENABLED` | `true` | `true` |
| `NODE_ENV` | `production` | `production` |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | `0.0.0.0` / `8080` |

**CONFIRMED.** `flyctl secrets list -a kaching-api` (names only) has **no** `DELIVERY_RECOVERY_*` secrets, so Fly `[env]` is not overridden to `2000` or `REDIS_SCAN=1`. `REDIS_URL` and `REDIS_ENABLED` remain deployed secrets (values not read).

---

## 5. RECOVERY WORKER STATUS

**CONFIRMED.** The one-line boot log `[DurableDelivery] recovery worker started intervalMs=15000 redisIndexScan=off` had already rotated out of the `flyctl logs --no-tail` buffer by the time it was queried. Equivalent live evidence:

Process env: `INTERVAL=15000`, `REDIS_SCAN=0`, `PROCESS_BUDGET=8`.

Periodic metrics (every 60s), machine `683d1292f2d948` at `2026-09-02T10:05:49Z`:

```
[DurableDelivery] recovery metrics | ticks=17 overlapSkips=0 hscan=0 hydrates=0 gets=0 discovered=128 recovered=128 terminalSkipped=0 indexRemoved=18 lastDurationMs=160 redisFails=0 circuit=closed redisScan=off intervalMs=15000
```

Later sample (`ticks=19`):

```
[DurableDelivery] recovery metrics | ticks=19 overlapSkips=0 hscan=0 hydrates=0 gets=0 discovered=144 recovered=144 terminalSkipped=0 indexRemoved=48 lastDurationMs=168 redisFails=0 circuit=closed redisScan=off intervalMs=15000
```

| Check | Result |
|---|---|
| Actual recovery interval | **15000 ms** (`intervalMs=15000`; ~15s between ticks) |
| Redis index scan | **off** (`redisScan=off`; env `0`) |
| MongoDB recovery | **running** — `discovered`/`recovered` increase by the process budget (~8/tick) |
| HSCAN activity | **none** (`hscan=0`) |
| Hydration GET activity | **none** (`hydrates=0`, `gets=0`) |
| Overlap skips | `0` |
| Redis circuit | `closed`, `redisFails=0` |
| Tick duration | 160–211 ms (not a 41k-member walk) |
| STOP condition (`redisIndexScan=on` or interval 2000 / below 5000) | **not met** — deploy left in place |

Mongo is recovering a backlog of historical due jobs (retries, `rehydrate_error`, `FAILED_TERMINAL`, duplicate fan-out claims). That is Mongo-primary crash recovery draining old unfinished rows, **not** a Redis `djobidx` scan.

`indexRemoved` increasing (18 → 48) is best-effort Redis `HDEL` of members that already reached a Mongo terminal state, not index walking.

---

## 6. APPLICATION HEALTH STATUS

**CONFIRMED.**

Live `GET https://kaching-api.fly.dev/api/health` (after Redis connect):

```json
{
  "status": "ok",
  "service": "backend",
  "licenseTokenCrypto": "ok",
  "redis": {
    "redisConfigured": true,
    "redisConnected": true,
    "lastSuccessfulRedisOperation": "connect",
    "lastSuccessfulRedisAt": "2026-09-02T10:01:48.937Z",
    "lastRedisErrorCode": null,
    "lastRedisErrorAt": null,
    "redisLatencyMs": 1244
  }
}
```

| Check | Result |
|---|---|
| API | **ok** (HTTP 200, `status: ok`) |
| Mongo | **up** — recovery queries return due jobs; no `MongoDB connection error` in the inspected log window |
| Redis | **configured and connected** on the public health endpoint; `lastRedisErrorCode` null |
| Fly service checks | both machines **passing** |
| Restart loop | **none** (one start per machine) |
| Redis reconnect storm | **not observed** (`redisFails=0`, circuit closed, no Redis error codes on health) |

Fly’s stored check output briefly showed `redisConnected: false` from the first probe before the client finished connecting (~1.2s connect). The live health body above is the current state.

---

## 7. REDIS COMMAND RISK STATUS

**CONFIRMED.** Production recovery is not walking `kaching:trade:djobidx`.

Measured in live metrics: `hscan=0`, `hydrates=0`, `gets=0`, `redisScan=off`, interval 15s.

Idle recovery command volume from the old 2s + HSCAN/GET loop is **stopped**. Remaining Redis use in this window is per-job lease/index `HDEL` (`indexRemoved`) and normal live-path clients — not 32 GETs every 2s against ~41k members.

Historical ~41k index members are **still in Redis**. They are no longer scanned by recovery. They will stay until a later admin cleanup (not part of this deploy).

---

## 8. LIVE SIGNAL PIPELINE STATUS

**NOT YET VERIFIED IN LIVE PRODUCTION**

Logs in the verification window show recovery of **already-known** jobs (duplicate fan-out claims for existing `tvw_*` request ids, `RETRY_SCHEDULED`, `FAILED_TERMINAL` / `rehydrate_error` on stale payloads). That is background recovery, not a new live TradingView ENTRY completing Telegram / email / MT5.

No genuine new live ENTRY → Telegram / email / MT5 success was observed during this verification period.

Do not treat duplicate-suppressed historical fan-out as live-delivery proof.

---

## 9. WARNINGS OR RISKS

| Item | Label |
|---|---|
| Boot line `recovery worker started … redisIndexScan=off` rotated out of `flyctl logs` buffer; config proven via env + metrics | WARNING |
| Mongo is draining a backlog of historical due jobs (`rehydrate_error` / terminal). Expected after deploy; watch until `discovered` per tick drops | WARNING |
| Both machines recover in parallel; Redis leases + duplicate suppression apply. Some duplicate fan-out log noise | WARNING |
| ~41k `djobidx` members remain until a later dry-run cleanup | WARNING |
| `frontend/` in the backend Docker context made the image upload slow; does not affect runtime | WARNING |
| No git SHA; rollback is by Fly image tag only | WARNING |
| Live Telegram / email / MT5 path not observed yet | ASSUMPTION / pending |

No condition requiring rollback was observed (scan off, interval 15000, machines healthy).

---

## 10. REDIS CLEANUP STATUS

**NOT STARTED**

`scripts/cleanup-djobidx.js` was not run against production. Redis was not flushed. The whole `kaching:trade:djobidx` key was not deleted.

---

## 11. ROLLBACK STATUS

**NOT USED.**

Rollback image remains available if needed:

`registry.fly.io/kaching-api:deployment-01M1F106J14WQB4Y8F2P48KZQC` (v153)

---

## 12. FINAL VERDICT

**DEPLOYMENT SUCCESSFUL — CRITICAL VERIFICATION PENDING**

Version 154 is live, healthy, and running recovery at **15000 ms** with **Redis index scan off** and **zero HSCAN/GET** on `djobidx`. The Redis recovery-index command explosion is stopped in production.

Live TradingView → Telegram / email / MT5 has **not** been confirmed from a genuine new signal in this window. Watch the next real webhook before treating the delivery path as verified.
