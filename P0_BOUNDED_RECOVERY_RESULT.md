# P0 — Bounded Durable Delivery Recovery Result

**Status:** IMPLEMENTED on the isolated tree. **NOT READY TO DEPLOY. WAIT FOR APPROVAL.**  
**No production Redis/Mongo writes. No restart. No deploy.**

## Root cause confirmation

Production OOM is the recovery tick fully materializing Redis `kaching:trade:djobidx` (HLEN=41252, ~3.2KB JSON each): HGETALL → GET every job → JSON.parse → unbounded `memJobs`/`durableDocs` → `isDue` after the full load. ~132MB raw JSON + V8 overhead exceeds the ~256MB heap. Overlapping ticks are not the primary cause; `workerTickInFlight` was already present and is kept.

## Files changed

| File | Change |
|------|--------|
| `utils/durableDelivery.js` | Bounded HSCAN recovery, cache caps, HDEL index on **future** terminal writes, `getCounts` without `listJobs`, `onEntryCommitted` without full hydrate |
| `services/TradeDeliveryService.js` | Thread `waitMode` on recovery `deliverDurableJob` only |
| `services/TradingViewAlertService.js` | Recovery handler `waitMode=check_once`; `inMemorySignals` cap 400 |
| `server.js` | Comment only: owner of `inMemorySignals` array |
| `services/__tests__/durableDeliveryBoundedRecovery.test.js` | New tests for the 15 forensics items |
| `P0_BOUNDED_RECOVERY_PLAN.md` | Written **before** source edits |
| `P0_BOUNDED_RECOVERY_RESULT.md` | This file |

## Files not changed (protected)

- `utils/deliveryIdempotency.js`
- `services/PipelineStatusService.js` (still calls `DurableDelivery.getCounts()`; `getCounts` no longer hydrates)
- RC-E / RC-G, ENTRY-before-outcome, Redis fail-closed, Pine/TV/credentials, Dockerfile RAM, `--max-old-space-size`

## Old recovery flow

```
tick → listDueJobs → listJobs → hGetAll(djobidx)
     → GET+JSON.parse every id → retain memJobs
     → filter isDue → sequential handler (live sequencer wait)
getCounts → listJobs (same full hydrate)
```

## New recovery flow

```
tick (workerTickInFlight kept)
  → durableDocs/memJobs due (already in process, cap 256)
  → Mongo unfinished+due query limit 8 (prod)
  → HSCAN djobidx COUNT=100, cursor persisted
  → GET+parse ≤32 IDs
  → isDue on that batch
  → process ≤8 due jobs, concurrency 2
  → drop terminal refs; do not retain them
  → resume cursor next tick
getCounts → Mongo $group by state (prod) or memory maps (test)
          → Redis HLEN for redisIndexSize
          → never listJobs / never GET 41k
```

## Memory bound (512MB Node / ~256MB V8)

| Knob | Value | Peak vs old 132MB+ |
|------|-------|--------------------|
| HSCAN COUNT | 100 | IDs only, ~15KB |
| Hydrate batch | 32 | ~102KB JSON / ~1MB parsed |
| Process / tick | 8 | Provider work capped |
| Provider concurrency | 2 | Not `Promise.all(allJobs)` |
| Scan steps / tick | 8 | ≤800 IDs visited, ≤32 hydrated |
| memJobs / durableDocs | 256 each | ~2MB each |
| inMemorySignals | 400 | Recent hundreds |

Working set stays well under 15MB per tick.

## Redis safety

- This change does not connect to production. No FLUSH, no bulk DEL of the 41k, no requeue.
- Recovery reads: HSCAN + batch GET. Existing job state-machine writes unchanged.
- **New write only:** when a job **becomes terminal after deploy**, `HDEL` that field from `djobidx`. Existing 41k members are not migrated.
- Ingest/lease still fail-closed. No process-local fan-out fallback.
- Index values remain `"1"` for active jobs.

## Cache bounds

- **Never evict:** `processing`/`sending` with a live lease.
- **Evict first:** `delivered`, `failed_terminal`, `skipped`, `not_eligible`.
- Then oldest non-leased if still over max.
- Cardinality cannot track Redis job count. Production durable record remains Mongo; Redis job JSON remains until TTL.
- Recovery hydrations of terminal jobs are not inserted into `memJobs`.

## Blocked job handling

- Recovery call sites pass `waitMode=check_once` (no live 3s/120s poll).
- Live sequencer defaults **unchanged** (3000ms wait / 50ms poll).
- `nextAttemptAt` for `blocked_waiting_for_entry` **unchanged** (~1s, `sendAttempts` not incremented). A new backoff would change customer-visible timing; not invented.
- Bound: check_once per attempt + 8 due jobs per tick.

## getCounts handling

- Does **not** call `listJobs()`.
- Prod: Mongo `aggregate $group by state` (indexed `state`).
- Redis `HLEN` → `redisIndexSize` (may include historical terminals still in the index).
- Tests / Mongo down: in-process maps; `approximate: true` if HLEN > counted docs.
- `PipelineStatusService.js` unchanged.

## inMemorySignals handling

- Owner: `server.js` (`const inMemorySignals = []`).
- Writes: `TradingViewAlertService.saveSignal` unshift then `capInMemorySignals`.
- Max **400**. Evict oldest completed (`closed` / TP3 / SL / expired) first, then oldest tail.
- Lookup miss falls through to Mongo.

## Test results

| Run | Result |
|-----|--------|
| `node --check` on changed JS | pass |
| `durableDeliveryBoundedRecovery.test.js` | **11 pass / 0 fail** |
| durable + sequencing + accounting | **90 pass / 0 fail** |
| Telegram + webhook + pipeline + persist | **104 pass / 0 fail** |
| **full `npm test`** | **785 tests, 783 pass, 0 fail, 2 skipped** |

Frontend not touched — no frontend build.

The 41252×3.2KB case is proven with **counters** (GET/parse/HSCAN/HGETALL). Max concurrent hydrations ≤ 32. Parsed bytes per tick ≪ 132MB. HGETALL of `djobidx` is 0.

## Protected file hashes (must match HASHES_BEFORE / HASHES_AFTER)

```
F5129124604531B2BC90D696148BD5D8C1997F9B1E2D95797C294A1B64DB666F  utils/deliveryIdempotency.js
A269656B16998645E272506572E9CA2CBAE6F30344B79751D87879CC31694D0A  services/PipelineStatusService.js
```

Unchanged. Match both HASHES files.

## Static search (remaining)

| Symbol | Remaining meaning |
|--------|-------------------|
| `hGetAll` | `tradeEventStore.js` only — per-trade orphan / seq-commit hashes, **not** `djobidx` |
| `listJobs(` | Test inspection + `listMemoryJobs()` (process-local, bounded). Recovery/getCounts do not call it |
| `memJobs` / `durableDocs` | Bounded Maps with eviction |
| `startRecoveryWorker` / `setInterval` | Kept; `workerTickInFlight` skip still in place |
| `processDueJobs` | Bounded collect + concurrency 2 |
| `Promise.allSettled` | RC-G ENTRY email/telegram/MT5 — **kept** |
| `Promise.all` | Recovery **2 workers** only; fan-out `mapWithConcurrency`; rehydrate signal+subscriber |
| `inMemorySignals` | Capped at 400 |
| `blocked_waiting_for_entry` | Policy unchanged; recovery uses check_once |
| `missing_channel_payload` | Unchanged retry path |

## Remaining risks

1. Existing ~41k terminal index members still require batched GET to skip until TTL/index expiry; they are no longer retained or processed as due. First hours after deploy still walk the index at 32 hydrations / 2s — CPU/Redis GET traffic, not heap OOM.
2. `onEntryCommitted` no longer scans the full Redis index. Immediate unblock relies on process-local + Mongo query. Recovery still picks up blocked jobs when `nextAttemptAt` is due.
3. `getCounts.redisIndexSize` (HLEN) can exceed per-state Mongo totals until historical terminals leave the index. State counts are Mongo/memory; document as possibly approximate.
4. Two machines still both run recovery (by design). Leases still serialize sends. Both now stay inside the same memory bound.
5. `durableDocs` eviction in tests does not fire (≪ 256 jobs). If a future test creates >256 active jobs, it must not rely on unbounded retention.

## Deployment readiness

**NOT READY TO DEPLOY / WAIT FOR APPROVAL**

Do not restart production. Do not flush Redis. Do not modify production Mongo. Do not change Fly RAM.
