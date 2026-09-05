# DURABLE DELIVERY RECOVERY REPORT

Production was not changed. This work is local only. Do not deploy, commit, or push until approved.

**Verdict:** NOT SAFE TO DEPLOY until the user approves. Critical invariants are demonstrated by tests. Production remains Fly `kaching-api` v139 / Pine 1.3.0.

---

## 1. Executive summary

Two remaining red flags after ENTRY-first sequencing:

1. **`claimFanout` SET NX (24h) meant EVENT CLAIMED ≠ EVENT DELIVERED.** A crash after the claim left Telegram/Email never sent; retries saw “already claimed.”
2. **ENTRY send failure blocked outcomes forever** (correct ordering) **without durable retry** (incorrect recovery). Solving that by sending TP3 before ENTRY was forbidden and was not done.

**Fix:** one durable delivery state machine (`backend/utils/durableDelivery.js`):

`PENDING → PROCESSING → RETRY_PENDING → DELIVERED | FAILED_TERMINAL`

(plus `blocked_waiting_for_entry` while outcomes wait for ENTRY commit).

HTTP 202 still does not wait for Telegram. Durable fan-out work is created **before** 202. Processing uses expiring leases. Success is terminal only after provider success. A recovery worker reclaims expired leases across Fly machines.

Pine is unchanged. Webhook URL and `{{alert_message}}` are unchanged. Redis remain fail-closed.

---

## 2. Phase 1 audit (exact answers)

| # | Question | Answer |
|---|----------|--------|
| 1 | Where event becomes eligible for fan-out | `TradingViewAlertService.acceptAfterValidation` returns `accepted: true` (~1425). `server.js` ~875 schedules when not duplicate/skipped. |
| 2 | Where `claimFanout` happened | `tradeEventStore.js` 418–423 (definition). Only production caller was `TradingViewAlertService.processAcceptedTradingViewSignal` ~1506. |
| 3 | Claim TTL | Yes. `DEFAULT_CLAIM_TTL_SEC = 86400` via `claimNx` SET NX EX (`tradeEventStore.js` 26, 371). No release on success or failure. |
| 4 | Process dies after `claimFanout` | Redis key held 24h. Process-local dispatcher queue lost. Mongo Signal may stay `pending`. No sweeper. |
| 5 | Rediscovery | **No** automatic rediscovery. `takeBufferedDeliveries` was exported and never called. |
| 6 | Duplicate webhook recovery | **No.** `claimEventId` miss → `ackNoFanout` skippedFanout. Duplicate is idempotent skip, not retry. |
| 7 | Process restart recovery | **No.** Dispatcher `states` Map is process-local (`tradeEventDispatcher.js` 26). |
| 8 | Machine B recover machine A | **No** for crashed fan-out (`claimFanout` false for 86400s). Orphans yes (Redis HASH). |
| 9 | `claimDelivery` permanent loss | **Yes.** SET NX 86400s + Mongo `deliveredKeys` **before** Telegram 200 (`deliveryIdempotency.js` 50–80, `TradeDeliveryService.js` telegram send after claim). Crash after claim = slot consumed, sequencer never commits ENTRY. |
| 10 | Telegram/email state durable? | Partial: Mongo flags via `persistDeliveryFlags` after send; sequencer commit HASH is Redis-only; claims were Redis+Mongo **before** success. |

Existing jobs: no BullMQ. Reused pattern: `startManualConfirmExpiryJob` 30s interval. New recovery worker follows that pattern (`DurableDelivery.startRecoveryWorker`).

---

## 3. Root cause

Permanent boolean SET NX was used as both **processing lock** and **completion record**. Those must be separate:

- PROCESSING claim must expire (lease).
- SUCCESS commit must happen only after provider success.
- Unfinished work must live in durable storage so another machine can reclaim it.

---

## 4. State machine

```
                    ensureFanoutWork / ensureJob
                              │
                              ▼
                           PENDING
                              │
                     beginAttempt (SET NX lease)
                              ▼
                         PROCESSING
                         (owner, leaseUntil, attemptCount, lastAttemptAt)
                              │
              ┌───────────────┼───────────────────┐
              │               │                   │
     provider success    send failure      predecessor missing
              │               │                   │
              ▼               ▼                   ▼
          DELIVERED     RETRY_PENDING    BLOCKED_WAITING_FOR_ENTRY
                         (backoff)         (does not burn sendAttempts)
                              │                   │
                    sendAttempts >= MAX     ENTRY committed
                              │                   │
                              ▼                   ▼
                      FAILED_TERMINAL      RETRY_PENDING (due now)
                              │
                    retryFailedTerminal (admin/internal)
                              │
                              ▼
                         RETRY_PENDING
```

Lease expiry while PROCESSING → another owner may `beginAttempt` (RECOVERED). Live lease → BUSY (one winner).

---

## 5. Red flag #1 — crash after claimFanout

**OLD:** SET NX 24h. Crash after claim → retries see claimed → never delivered.

**NEW:** Fan-out job created before 202 (`ensureFanoutWork`). `beginFanoutAttempt` is a lease. Crash → `simulateCrash` / leaseUntil past → machine B reclaims. Success commit is a separate `commitDelivered`.

**Proof:** `durableDeliveryRecovery.test.js` A/1, P, D, O.

---

## 6. Red flag #2 — ENTRY failure without durable retry

**OLD:** Failed Telegram consumed `claimDelivery`. Sequencer did not commit ENTRY. Outcomes waited then buffered (`seqbuf`) with **no drain**. No retry.

**NEW:** Failed ENTRY → `RETRY_PENDING` + exponential backoff. Outcomes stay blocked (`blocked_waiting_for_entry`). ENTRY success commits sequencer and `onEntryCommitted` unblocks outcomes. Never TP3 before ENTRY.

**Proof:** `durableDeliveryRecovery.test.js` L/M, C, N. Existing `entryFirstDeliverySequencing.test.js` still passes.

---

## 7. Lease design

- Redis/memory lease key `kaching:trade:dlease:{jobId}` SET NX.
- Job document `leaseUntil` is expiry authority (fake Redis has no PX; production PX is extra).
- Expired PROCESSING: log LEASE EXPIRED, DEL lease, reclaim.
- `DELIVERY_PROCESSING_LEASE_MS` default 120000.
- Two Fly machines: one SET NX winner. Test O: Promise.all two owners → 1 acquired + 1 busy.

---

## 8. Identity

Stable: `eventId::canonicalTradeId::subscriberId::channel::eventType`

Never random on retry. Legacy payloads without Pine `eventId` use `canonicalTradeId`/`signalUuid` plus `eventType` so ENTRY and TP3 cannot collide.

Fan-out job: `subscriberId=_event`, `channel=_fanout`.

---

## 9. ENTRY-first survival

`deliverySequencer.withChannelSequence` is unchanged as the ordering authority. Commit still requires `result.ok === true`. On ENTRY commit: `onEntryCommitted` + `takeBufferedDeliveries` (previously dead). Allowed: ENTRY→TP3 if TP1/TP2 never accepted. Forbidden: TP3→ENTRY.

---

## 10. Fast ack

Path: auth → validate → canonicalize → `claimEventId` → persist → **`ensureFanoutWork`** → HTTP 202 → `scheduleAcceptedTradingViewSignal` (async Telegram).

Durable fan-out job exists before 202. 202 does not wait for Telegram.

**Proof:** `webhookFastAck.test.js` test 2; `durableDeliveryRecovery.test.js` G and 12.

---

## 11. Multi-machine

- Accept: existing Redis canonical lock + `claimEventId` (fail-closed 503).
- Fan-out/delivery: lease + durable job documents (memory in tests, Redis HASH/JSON in production, Mongo `delivery_jobs` when connected).
- Recovery worker on each machine; duplicate workers are harmless; one lease winner.
- Test P: fly-1 acquires, fly-2 busy; after commit, fly-2 sees `delivered`.

---

## 12. Duplicate webhook

Still idempotent at `claimEventId`. Does **not** create a second canonical event or a second job. Recovery is the worker, not TradingView retries. Same identity reused.

---

## 13. Legacy compatibility

No Pine regeneration. Delivery keys on `canonicalTradeId` / `eventId` / `eventType` / `eventSequence`. Works for legacy, 1.2.x, 1.3.0, stable-v1. Test H.

Webhook URL remains `https://api.kachingscanner.com/api/webhook/tradingview`. `{{alert_message}}` unchanged.

---

## 14. Observability

Structured `[DURABLE DELIVERY]` + `logPipeline('DurableDelivery', …)` without secrets (ids hashed):

DELIVERY CREATED, LEASE ACQUIRED, BLOCKED_WAITING_FOR_ENTRY, ENTRY ATTEMPT path via LEASE ACQUIRED, ENTRY SUCCESS, ENTRY FAILED, RETRY SCHEDULED, LEASE EXPIRED, RECOVERED, MARKED DELIVERED, FAILED TERMINAL, OUTCOME UNBLOCKED, DUPLICATE SUPPRESSED.

`PipelineStatusService.getStatus()` adds:

- `lastDurableDelivery`
- `durableDeliveryState`
- `durableDeliveryCounts` `{ pending, processing, retry_pending, delivered, failed_terminal, blocked_waiting_for_entry }`

DurableDelivery FAIL does **not** overwrite `lastFailureStage` (Broadcast / DeliveryTelegram remain operator-facing).

---

## 15. Files changed

| File | Change |
|------|--------|
| `backend/utils/durableDelivery.js` | **New.** State machine, leases, recovery worker. |
| `backend/models/DeliveryJob.js` | **New.** Mongo durable record (best-effort when DB connected). |
| `backend/utils/tradeEventStore.js` | `claimFanout` is lease-based; `getInjectedClient`; reset clears durable store. |
| `backend/utils/deliveryIdempotency.js` | PROCESSING lease vs SUCCESS commit. |
| `backend/services/TradeDeliveryService.js` | Commit after provider success; retry on fail; `deliverDurableJob`. |
| `backend/services/TradingViewAlertService.js` | `ensureFanoutWork` before accept return; lease fan-out; `processDurableJob`. |
| `backend/utils/deliverySequencer.js` | Blocked-job persist; ENTRY commit unblocks; drain `seqbuf`. |
| `backend/services/PipelineStatusService.js` | Durable delivery diagnostics. |
| `backend/server.js` | Start recovery worker (not in `NODE_ENV=test`). |
| `backend/.env.example` | `DELIVERY_MAX_ATTEMPTS`, retry/lease/recovery env vars. |
| `backend/services/__tests__/durableDeliveryRecovery.test.js` | **New.** A–P + fast-ack replica. |
| `backend/utils/__tests__/webhookFastAck.test.js` | Assert durable work exists at 202. |
| `backend/DURABLE_DELIVERY_RECOVERY_REPORT.md` | This file. |

Not modified: Pine templates/snippets, webhook URL, LicenseTokenService, M-Pesa, MT5 pairing.

---

## 16. Tests

**New:** `durableDeliveryRecovery.test.js` (17 tests: A–P, HTTP 202 replica, PipelineStatus).

**Existing (must stay green):**

- `entryFirstDeliverySequencing.test.js`
- `pineCompatibilityLayer.test.js`
- `kachingAlertOnce.test.js`
- `distributedLifecycleFix.test.js`
- `webhookFastAck.test.js`
- `telegramTradeAlertDelivery.test.js`

**Also:** `node scripts/smoke-pine-gen.js` (NODE_ENV=test), full `npm test`.

---

## 17. Test results (local)

| Run | Result |
|-----|--------|
| `durableDeliveryRecovery.test.js` | **17/17 pass** (A–P, HTTP 202 replica, PipelineStatus) |
| Related suite (durable + entryFirst + pineCompatibility + kachingAlertOnce + distributedLifecycle + webhookFastAck + telegramTradeAlertDelivery) | **139/139 pass, 0 fail** (included in full `npm test`) |
| `cmd /c "set NODE_ENV=test&& node scripts/smoke-pine-gen.js"` | **ok: true**, violations 0 |
| Full `npm test` | **695 tests, 152 suites, 693 pass, 0 fail, 2 skipped, 0 todo** (~140s) |

Skipped (pre-existing, Redis not available in this environment; MT5 pairing not weakened):

- `stores and atomically consumes PairCode via Redis GETDEL when available`
- `concurrent Redis completePairing yields a single winner`

No assertions were weakened. No tests were skipped to go green.

---

## 18. Remaining risks

- **At-least-once:** crash after Telegram HTTP 200 and before `commitDelivered` can resend. Telegram idempotency keys are not used. Documented; not exactly-once.
- **Fan-out marked delivered after expansion attempt:** child channel jobs retry independently. If fan-out crashes before any child job exists, the fan-out lease expires and expansion reruns.
- **Mongo `DeliveryJob` is best-effort.** Redis/memory job documents are the operational store. If Redis loses keys after TTL (7d), Mongo is the audit trail; a full Mongo rescan worker was not added.
- **`TradeEventDispatcher` is still process-local** (optimization only). Cross-machine authority is durable jobs + sequencer Redis.
- **Outcome `seqbuf` drain** unblocks jobs; actual resend is recovery `processDueJobs`.
- Telegram 200 = queued at Telegram, not phone display.
- Known suite flake: `mt5Pairing.test.js` + `mt5ReliabilityHardening.test.js` sharing `dev-users.json` under parallel Node test. Unrelated; pairing not weakened.

---

## 19. At-least-once boundary

| Crash point | Result |
|-------------|--------|
| After persist, before `ensureFanoutWork` | Accept already claimed; work create is in the same accept path — if Redis throws, HTTP 503. |
| After durable work, before 202 | Work exists; worker/process recovers. |
| After fan-out lease, before send | Lease expires; another machine reclaims. |
| After Telegram 200, before local commit | Possible duplicate send (at-least-once). |
| After commit | Duplicate webhook / second claim → DUPLICATE SUPPRESSED. |

---

## 20. Deployment readiness

**NOT SAFE TO DEPLOY** until explicitly approved.

Production is Fly `kaching-api` **v139**. This stacks with undeployed Pine compatibility + ENTRY-first sequencing.

When approved: backend only. No webhook URL change. No subscriber Pine update. Redis remains required (fail-closed). Configure:

```
DELIVERY_MAX_ATTEMPTS=8
DELIVERY_RETRY_BASE_DELAY_MS=500
DELIVERY_RETRY_MAX_DELAY_MS=60000
DELIVERY_PROCESSING_LEASE_MS=120000
DELIVERY_RECOVERY_INTERVAL_MS=2000
```

Env config:

- `DELIVERY_MAX_ATTEMPTS` (default 8)
- `DELIVERY_RETRY_BASE_DELAY_MS` (default 500)
- `DELIVERY_RETRY_MAX_DELAY_MS` (default 60000)
- `DELIVERY_PROCESSING_LEASE_MS` (default 120000)
- `DELIVERY_RECOVERY_INTERVAL_MS` (default 2000)

---

## Invariants (tests)

1. Crash after fan-out claim recoverable (A).
2. Crash after `claimDelivery` recoverable (B).
3. Success recorded only after provider success (C).
4. Processing claims expire (D).
5. Completed deliveries idempotent (E).
6. Redis fail-closed (F).
7. 202 / accept after durable work; Telegram not on HTTP path (G, 12, webhookFastAck 2).
8. No Pine update (H, smoke-pine-gen).
9. Different trades independent (I).
10. Multi-subscriber independent (J).
11. Telegram vs Email independent (K).
12. ENTRY fail blocks TP3 (L).
13. Retry unblocks (M).
14. FAILED_TERMINAL recorded and recoverable (N).
15. Simultaneous recovery one winner (O).
16. Two machines one job identity (P).
17. Duplicate webhook no second Telegram (E, P).
18. ENTRY-first still holds (`entryFirstDeliverySequencing.test.js`).
