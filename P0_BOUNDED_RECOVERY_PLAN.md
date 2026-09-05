# P0 — Bounded Durable Delivery Recovery Repair Plan

**Status:** PLAN ONLY at time of writing. No source edits yet.  
**Scope:** Isolated tree `C:\TEMP\kaching-v146-correlation-repair`. No deploy, no production Redis/Mongo, no process restart.

## Root cause

Production v147 (Node 20.20.2, 512MB, no swap) OOMs at ~251–259MB heap (exit 134) because **every recovery tick fully materializes Redis `kaching:trade:djobidx`**.

Proven path:

1. `listJobs()` → `listJobIds()` **HGETALL** of ~41,252 index fields
2. `readJob()` **GET** every job key
3. **JSON.parse** every ~3.0–3.4KB payload
4. Retain every object in **unbounded** `memJobs` / `durableDocs`
5. `isDue()` runs **after** full materialization
6. Terminal jobs stay in the index (`HSET … '1'`) and are still GET+parsed even though `isDue` rejects them
7. `getCounts()` calls `listJobs()` (PipelineStatus every poll)
8. Recovery omits `waitMode=check_once`, so blocked jobs can take the live 3s sequencer poll
9. `blocked_waiting_for_entry` is due every ~1s without incrementing `sendAttempts` (existing policy; do not invent a new backoff)

~41k × 3.2KB ≈ 132MB raw JSON + V8 overhead exceeds the ~256MB heap. Overlapping ticks are **not** the primary cause (`workerTickInFlight` already exists and must be kept).

## Current dangerous path

```
startRecoveryWorker tick (2s)
  → processDueJobs
    → listDueJobs → listJobs → listJobIds
         Redis hGetAll(djobidx)          // 41k fields
         ∪ memJobs.keys() ∪ durableDocs ∪ Mongo unfinished
    → for each id: readJob → GET + JSON.parse + memJobs.set
    → filter isDue
    → sequential handler (Telegram/email/fan-out)
```

Same full hydrate: `getCounts()`, `onEntryCommitted()`.

## Proposed bounded path

```
tick (keep workerTickInFlight)
  → HSCAN djobidx COUNT=100, cursor persisted across ticks
  → take ≤32 IDs this tick
  → GET+parse only that batch (never the whole index)
  → isDue on the batch only
  → process ≤8 due jobs with provider concurrency ≤2
  → drop batch refs; evict terminal from memJobs/durableDocs
  → stop at per-tick budget; resume cursor next tick
```

Mongo (when connected): query **unfinished + due** with `limit`, not a full collection dump.  
Do **not** replace HGETALL with HSCAN-then-GET-all-41k.

Optional **new writes only**: when a job **transitions to terminal after this code is deployed**, `HDEL` it from `djobidx`. Do **not** migrate/delete the existing 41k production members.

## Files to change

| File | Why |
|------|-----|
| `utils/durableDelivery.js` | Bounded scan, cache caps, getCounts, onEntryCommitted, processDueJobs budget, terminal index HDEL on future writes |
| `services/TradeDeliveryService.js` | Thread `waitMode` on recovery `deliverDurableJob` only |
| `services/TradingViewAlertService.js` | Recovery handler passes `waitMode=check_once`; cap `inMemorySignals` |
| `server.js` | Owner of `inMemorySignals` array — cap helper at write sites only if required (primary cap is in TradingViewAlertService) |
| `services/__tests__/durableDeliveryBoundedRecovery.test.js` | New tests for the 15 forensics items (mock/counter, no 132MB alloc) |
| `P0_BOUNDED_RECOVERY_PLAN.md` / `P0_BOUNDED_RECOVERY_RESULT.md` | This plan + result |

## Files explicitly protected (must not change)

- `utils/deliveryIdempotency.js` — SHA256 must match HASHES_BEFORE/AFTER
- `services/PipelineStatusService.js` — fix `getCounts()` so this file does not need to change
- RC-E / RC-G behavior in TradingViewAlertService / TradeDeliveryService
- ENTRY-before-outcome / live sequencer defaults (`DELIVERY_SEQ_WAIT_MS=3000`)
- Redis-as-authority / fail-closed (no process-local fan-out fallback)
- Pine / TradingView / Telegram / Email credentials
- Dockerfile RAM / `--max-old-space-size` as the primary fix

## Memory bounds (512MB Node / ~256MB V8 heap)

| Knob | Value | Why safe |
|------|-------|----------|
| HSCAN COUNT | **100** | IDs only (~10–20KB), not job JSON |
| Hydrate batch | **32** | 32 × 3.2KB ≈ 102KB JSON; parsed ~0.5–1MB |
| Due processed / tick | **8** | Limits provider work + payload retention |
| Provider concurrency | **2** | Never `Promise.all(allJobs)` |
| Max HSCAN steps / tick | **8** | ≤800 IDs visited; ≤32 hydrated |
| `memJobs` max | **256** | ~256 × 8KB ≈ 2MB |
| `durableDocs` max | **256** | Same order; Mongo remains durable store in prod |
| `inMemorySignals` | **400** | Recent hundreds, not 41k |

**Peak recovery working set ≪ 15MB** vs ~256MB heap. Old path retained ~132MB+ parsed JSON every tick.

## Redis safety guarantees

- No production connection in this change. No FLUSH, DEL of job bodies, or requeue of the existing 41k.
- Recovery is **read** of index via HSCAN + **GET** of a batch. Writes are only the existing job state machine (lease, retry, commit) plus **optional HDEL of index field when a job newly becomes terminal**.
- Ingest/lease still **fail-closed** when Redis is down. No process-local fan-out fallback.
- Job JSON keys keep TTL; index membership for active jobs still `HSET field 1`.
- Existing 41k index members are **not** bulk-deleted. They may be scanned in batches; terminal payloads are not retained.

## Sequencing guarantees

- Live `withChannelSequence` waitMode **unchanged** (default live 3s / 50ms poll).
- Recovery call sites pass `waitMode=check_once` / `recovery` so blocked outcomes do one Redis/Mongo check, persist `blocked_waiting_for_entry`, return — no 3s/120s poll.
- ENTRY-before-outcome **unchanged**.
- `nextAttemptAt` for blocked jobs **unchanged** (still ~1s). Changing it would alter customer-visible delivery timing. Bound is: recovery check_once + per-tick process budget of 8.
- RC-E (stale ENTRY → `failed_terminal`, no provider send) and RC-G (`Promise.allSettled` independent ENTRY channels) **unchanged**.

## Cache eviction policy

**Never evict** while `processing` / `sending` with a live lease, or while the job is the in-flight handler target.

**Eligible for eviction:** `delivered`, `failed_terminal`, `skipped`, `not_eligible`, and stale non-leased jobs when over max cardinality.

**Order:** terminal first, then oldest `updatedAt` among non-leased unfinished (only if still over max — prefer not to evict `pending`/`retry_pending`/`blocked`/`provider_accepted` unless cardinality forces it).

Correctness: production durable record is Mongo; Redis job key remains until TTL. Eviction is process-local cache only. Tests use `durableDocs` as Mongo stand-in; tests create ≪ 256 jobs so eviction does not fire.

## Rollback considerations

- Revert the three (max four) JS files. No schema migration. No Redis migration to undo except: after deploy, newly terminal jobs may be absent from `djobidx`; rollback would `HSET` them again on the next `writeJob` of a non-terminal state. Harmless.
- HASHES of `deliveryIdempotency.js` and `PipelineStatusService.js` must be identical before/after.

## Test plan (15 forensics items)

Model 41,252 jobs × 3.2KB with a **fake Redis + counters**. Do **not** allocate 132MB.

1. Recovery does not HGETALL the whole index
2. GET count per tick ≤ hydrate batch (and ≤ batch × scan steps, never 41252)
3. JSON.parse count bounded the same way
4. `memJobs.size` ≤ 256 after scanning many terminals
5. Terminal jobs are not processed as due
6. Terminal hydrations are dropped (not retained)
7. `isDue` runs on the batch, not after full materialization
8. Two owners can still recover via leases (existing A/B tests remain)
9. `workerTickInFlight` still skips overlapping ticks
10. Overlap guard is not removed / not treated as the OOM fix
11. Recovery uses `waitMode=check_once` (no live 3s poll)
12. Blocked `nextAttemptAt` policy unchanged (still ~1s, no sendAttempts++)
13. Recovery call site passes check_once; live path does not
14. `getCounts()` does not call `listJobs()` / does not GET 41k
15. `inMemorySignals` capped with oldest-completed eviction

Plus: `node --check` on changed JS; targeted durable/sequencing/Telegram/email/webhook/pipeline tests; full `npm test`; 0 failures; do not weaken existing tests.
