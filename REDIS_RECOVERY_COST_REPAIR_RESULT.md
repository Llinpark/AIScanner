# Redis recovery cost repair

**Status:** Implemented and tested on this tree. **Not deployed. No production Redis/Mongo writes were performed.**

Live TradingView → Telegram / email / MT5 remains event-driven. This change only affects background crash recovery and an explicit admin cleanup of `kaching:trade:djobidx`.

---

## 1. ROOT CAUSE CONFIRMED

Kaching Scanner uses the `redis` npm package against Upstash (`REDIS_URL=rediss://…upstash.io:6379`) through one shared async client. `@upstash/redis` and `ioredis` are not used.

**Historical (pre-P0 bounded recovery):** every recovery tick called `HGETALL(kaching:trade:djobidx)` then `GET` + `JSON.parse` for every member. Production evidence: `HLEN ≈ 41,252`. That both OOMed the 512MB Fly VM and generated unbounded Upstash commands.

**Immediately before this change (P0 bounded recovery already in tree):** recovery no longer used `HGETALL`. It still:

1. Queried Mongo for unfinished due jobs (limit 8).
2. **Then continued to `HSCAN` the Redis index** (`COUNT≈100`, max 8 steps) and **`GET` up to 32 job blobs every 2 seconds**, even when Mongo returned no recoverable work.

Because ~41k historical members were still in `djobidx` (mostly terminal), the bounded worker kept hydrating stale IDs forever:

- ≈ 32 `GET` / 2s ≈ **1.38 million GET/day/machine** (estimate from prior audit)
- plus `HSCAN`, plus lease/webhook/pipeline commands

`server.js` starts `DurableDelivery.startRecoveryWorker` automatically. Live signal fan-out does **not** wait on that worker.

Index membership:

| Event | Index action |
|---|---|
| Non-terminal `writeJob` | `HSET djobidx jobId 1` |
| Terminal `writeJob` (after this change, Mongo-first) | best-effort `HDEL` |
| Historical terminals from before HDEL existed | remain until admin cleanup |

Terminal states in this schema: `delivered`, `failed_terminal`, `skipped`, `not_eligible`. There is no `cancelled` / `expired` DeliveryJob state.

Mongo `delivery_jobs` already has `{ state: 1, nextAttemptAt: 1 }` and `{ state: 1, leaseUntil: 1 }`. No new index migration was required.

---

## 2. BEFORE VS AFTER

All figures below are **estimates** unless marked measured. They count recovery-index traffic only, per application machine, idle (no due jobs).

| Era | Interval | Redis recovery discovery | Est. GET/day | Est. HSCAN/day |
|---|---|---|---|---|
| Unbounded (old) | 2s | `HGETALL` + `GET` × ~41,252 | ~1.78 billion | 0 (`HGETALL` instead) |
| P0 bounded (this tree, before this patch) | 2s | `HSCAN` + `GET` ≤ 32 | **~1.38 million** | ≤ ~345,600 |
| **This patch** | **15s** | **Mongo query only** (Redis scan default **off**) | **~0** | **~0** |

Measured in unit tests (this patch): default recovery against a 41,252-member fake index performed **0 HSCAN and 0 GET**. Opt-in `DELIVERY_RECOVERY_REDIS_SCAN=1` still caps hydrations at 32 per tick.

Other Redis usage (leases, webhook claims, sequence hashes, pipeline status `HLEN`) is unchanged and is **not** the 41k-index explosion.

One-time cleanup of 41k members is a separate, bounded admin pass (see §10), not a startup job.

---

## 3. `djobidx` STRATEGY

- **Recovery primary source is now Mongo** (tests: `durableDocs`). Query is unfinished + due only, `limit` = process budget (default 8), using existing state indexes.
- Redis `djobidx` is **no longer walked on every recovery tick**. Optional fallback: `DELIVERY_RECOVERY_REDIS_SCAN=1` (still bounded).
- **New terminals:** persist Mongo/durableDocs first → Redis job `SET` → best-effort `HDEL`. If `HDEL` fails, Mongo stays terminal; cleanup can remove the stale field later.
- **Historical members:** not bulk-deleted. Admin script inspects with `HSCAN` and `HDEL`s only proven terminal/orphan fields.
- Active / pending / recoverable jobs, including Redis-only unfinished jobs (possible leftover pending webhook/delivery JSON), are **preserved**.

---

## 4. CLEANUP TOOL

Script: `scripts/cleanup-djobidx.js`  
Core: `DurableDelivery.runIndexCleanupBatch` / `runIndexCleanupPass`  
**Not started from `server.js`.**

Default is DRY-RUN (zero `HDEL`).

```bash
# DRY-RUN (default)
node scripts/cleanup-djobidx.js --max-batches=10 --batch-size=100

# Continue a pass
node scripts/cleanup-djobidx.js --cursor=<resumeCursor>

# EXECUTE — requires explicit confirmation
CONFIRM_DJOBIDX_CLEANUP=YES node scripts/cleanup-djobidx.js --execute --max-batches=10 --batch-size=100
```

`--execute` without `CONFIRM_DJOBIDX_CLEANUP=YES` exits 2 and deletes nothing.  
EXECUTE also refuses if Mongo is not connected (cannot prove members are stale).

Report fields (actual schema names):

```json
{
  "mode": "DRY_RUN",
  "scanned": 500,
  "active": 12,
  "pending": 8,
  "recoverable": 4,
  "terminal": 470,
  "missingFromMongo": 6,
  "missingFromRedis": 2,
  "wouldDelete": 472,
  "deleted": 0,
  "preserved": 24,
  "cursor": "12345",
  "done": false
}
```

`wouldDelete` = Mongo/durable **terminal** + **orphans** (missing Mongo **and** missing Redis job JSON). Redis-only **unfinished** jobs are counted in `missingFromMongo` but **preserved**.

Resume: HSCAN cursor is printed; re-run with `--cursor`. Interrupted EXECUTE is safe: only already-verified fields were `HDEL`d; active jobs are never deleted.

Forbidden: no `HGETALL`, key enumeration of the whole DB, and no Redis database flush.

---

## 5. RECOVERY WORKER

| | Previous | New default |
|---|---|---|
| Interval | 2000 ms | **15000 ms** |
| Floor | none | **5000 ms** (`DELIVERY_RECOVERY_MIN_INTERVAL_MS`) |
| Redis index scan | every tick | **off** (`DELIVERY_RECOVERY_REDIS_SCAN=0`) |
| Process budget | 8 | 8 (max 32 via env) |
| Hydrate batch / scan steps / max Redis ops | 32 / 8 / n/a | 32 / 8 / 48 when scan enabled |
| Overlap | `workerTickInFlight` skip | same, plus `overlapSkips` counter and `finally` release |
| Circuit | none | after N Redis failures, skip Redis scan for cooldown; Mongo recovery continues |

**Why 15s:** live delivery is the webhook/fan-out path, not this worker. Lease TTL is 120s, so reclaim margin stays large. `onEntryCommitted` still unblocks TP/SL immediately. Retry backoff is already 500ms–60s; a 15s scan sits inside that curve. Override with `DELIVERY_RECOVERY_INTERVAL_MS`. Values below the floor are clamped unless `DELIVERY_RECOVERY_MIN_INTERVAL_MS` is also lowered.

Overlap guard is **process-local only**. Cross-machine duplicate sends still use Redis leases. Two Fly machines can both query Mongo; only the lease holder sends.

---

## 6. SAFETY VERIFICATION

| Requirement | Result |
|---|---|
| Live TradingView signal not delayed by recovery | Recovery is `setInterval` + `unref`; fan-out does not await it. Interval is slower, not faster. |
| Live Telegram / email | Unchanged APIs. `waitMode=check_once` only on recovery handler. Live sequencer default still 3000ms. |
| MT5 not executed twice by recovery | Redis leases + durable `DELIVERED` / `PROVIDER_ACCEPTED` (finish commit, no resend) unchanged. |
| Terminal jobs not scanned forever | Default path never walks `djobidx`. Terminals are not `isDue`. |
| Stale index member cleaned | Cleanup EXECUTE `HDEL`s proven terminal/orphan only (tested). |
| Active job preserved | Cleanup preserves pending/active/recoverable, including Redis-only unfinished (tested). |
| Restart does not lose Mongo jobs | Mongo query is the discovery path; Redis index optional. |
| Redis temporary failure | Isolated handler errors; circuit opens Redis scan; no in-tick retry storm (tested). |
| Multi-machine | Leases unchanged. Scan change does not add a second worker. |
| No `HGETALL(djobidx)` / key scan / DB flush in these paths | Static + mock tests. `tradeEventStore.js` still uses `hGetAll` on **per-trade orphan/seq hashes**, not `djobidx`. |

Idempotency (`utils/deliveryIdempotency.js`) was not modified.

---

## 7. FILES MODIFIED / CREATED

| File | Change |
|---|---|
| `utils/durableDelivery.js` | Mongo-primary recovery; Redis scan opt-in; 15s interval; overlap skip counter; Redis circuit; Mongo-first terminal `HDEL`; in-process metrics; cleanup APIs |
| `server.js` | Comment: recovery is background-only; cleanup is not auto-started |
| `.env.example` | New recovery/cleanup env vars |
| `scripts/cleanup-djobidx.js` | **Created** — DRY-RUN admin cleanup |
| `services/__tests__/durableDeliveryBoundedRecovery.test.js` | Default path must not HSCAN/GET the 41k index |
| `services/__tests__/durableDeliveryIndexCleanup.test.js` | **Created** — cleanup, overlap, batch, circuit, Mongo-primary |
| `REDIS_RECOVERY_COST_REPAIR_RESULT.md` | This report |

Not changed (protected behaviour): `utils/deliveryIdempotency.js`, Telegram/email/MT5 send APIs, TradingView Phase-A durability, Redis provider, lease implementation.

---

## 8. TEST RESULTS

**Before this patch** (measured):

```
services/__tests__/durableDeliveryBoundedRecovery.test.js
services/__tests__/durableDeliveryRecovery.test.js
→ 31 pass / 0 fail
```

**After this patch** (measured):

| Suite | Result |
|---|---|
| `durableDeliveryBoundedRecovery.test.js` + `durableDeliveryIndexCleanup.test.js` + `durableDeliveryRecovery.test.js` | **44 pass / 0 fail** |
| `finalReleaseHardening.test.js` + `telegramTradeAlertDelivery.test.js` + `entryFirstDeliverySequencing.test.js` + `liveEntrySlotRelease.test.js` | **85 pass / 0 fail** |
| full `npm test` | **868 tests, 862 pass, 2 skipped, 4 fail** |

The 4 full-suite failures are the known parallel-run flake in `mt5Pairing.test.js` / `mt5ReliabilityHardening.test.js` (shared `dev-users.json`). They do not import or exercise `durableDelivery` recovery/cleanup. Delivery, sequencing, Telegram, and idempotency suites above are green.

Required cases covered: terminal HDEL after durable commit; HDEL failure does not revert terminal state; stale vs active vs missing Mongo classification; DRY-RUN zero deletes; EXECUTE deletes only verified stale/terminal; process-local overlap skip; batch limit; terminals not reprocessed; Mongo/durable recovery without Redis index; Redis failure circuit; existing idempotency/sequencing/Telegram suites still pass.

---

## 9. MANUAL DEPLOYMENT STEPS

1. Deploy this backend only. Do **not** flush Redis. Do **not** run cleanup on startup.
2. Confirm Fly env (optional; defaults are already conservative):

```
DELIVERY_RECOVERY_INTERVAL_MS=15000
DELIVERY_RECOVERY_MIN_INTERVAL_MS=5000
DELIVERY_RECOVERY_REDIS_SCAN=0
DELIVERY_RECOVERY_PROCESS_BUDGET=8
```

If an old secret still has `DELIVERY_RECOVERY_INTERVAL_MS=2000`, the floor raises it to 5000 unless `DELIVERY_RECOVERY_MIN_INTERVAL_MS` is also set lower.

3. After deploy, watch logs for:

```
[DurableDelivery] recovery worker started intervalMs=15000 redisIndexScan=off
[DurableDelivery] recovery metrics | ... hscan=0 hydrates=0 ... redisScan=off
```

4. Confirm a live ENTRY still reaches Telegram/email as usual (webhook path, not recovery).
5. Do **not** enable `DELIVERY_RECOVERY_REDIS_SCAN=1` in production unless Mongo recovery is proven broken.

Rollback: revert this deploy. Newly terminal jobs may already be absent from `djobidx`; rollback will `HSET` them again on the next non-terminal write. Harmless. Historical 41k members remain until cleanup.

---

## 10. PRODUCTION CLEANUP PLAN (≈41,252 members)

Do this **after** the code deploy, on a one-off Fly machine or laptop with prod `REDIS_URL` + `MONGODB_URI`. Never from `server.js`.

1. **Dry-run a small window**

```
node scripts/cleanup-djobidx.js --max-batches=5 --batch-size=100
```

Review `scanned`, `active`, `pending`, `recoverable`, `terminal`, `missingFromMongo`, `wouldDelete`. `deleted` must be 0.

2. **If `recoverable` or Redis-only pending is non-zero**, inspect before execute. Those are preserved automatically; do not invent a bulk delete.

3. **Execute small batches** (repeat until `done=true` / cursor `0`):

```
CONFIRM_DJOBIDX_CLEANUP=YES node scripts/cleanup-djobidx.js --execute --max-batches=10 --batch-size=100
```

4. Between batches, confirm live Telegram/email still flow and `HLEN kaching:trade:djobidx` is falling.

5. Stop if `hdelFailures` rises or Mongo disconnects. Resume later with `--cursor`.

6. Expected end state: index cardinality ≈ current unfinished jobs (dozens, not 41k), not zero if live work exists.

**Do not** `DEL kaching:trade:djobidx`. **Do not** flush the Redis database. Other `kaching:*` keys (webhook claims, sequence hashes, MT5 pairing, pipeline diagnostics) must remain.

---

## Env reference

| Variable | Default | Role |
|---|---|---|
| `DELIVERY_RECOVERY_INTERVAL_MS` | 15000 | Background tick |
| `DELIVERY_RECOVERY_MIN_INTERVAL_MS` | 5000 | Clamp |
| `DELIVERY_RECOVERY_PROCESS_BUDGET` | 8 | Due jobs per tick (max 32) |
| `DELIVERY_RECOVERY_HYDRATE_BATCH` | 32 | Redis GET cap if scan on |
| `DELIVERY_RECOVERY_SCAN_STEPS` | 8 | HSCAN pages per tick if scan on |
| `DELIVERY_RECOVERY_MAX_REDIS_OPS` | 48 | HSCAN+GET cap if scan on |
| `DELIVERY_RECOVERY_REDIS_SCAN` | 0 | Walk `djobidx` during recovery |
| `DELIVERY_RECOVERY_REDIS_FAIL_THRESHOLD` | 5 | Circuit open |
| `DELIVERY_RECOVERY_REDIS_COOLDOWN_MS` | 30000 | Circuit cooldown |
| `DELIVERY_CLEANUP_BATCH_SIZE` | 100 | Cleanup HSCAN COUNT |
| `DELIVERY_CLEANUP_MAX_HDEL` | 50 | Max HDEL fields per cleanup batch |
| `CONFIRM_DJOBIDX_CLEANUP` | unset | Must be `YES` to delete |
