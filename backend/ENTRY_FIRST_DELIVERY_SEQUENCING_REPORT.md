# ENTRY-FIRST + DELIVERY SEQUENCING REPORT

Production was not changed. This work is local only. Do not deploy until approved.

**Verdict:** PARTIAL → fixed locally. Subscriber-visible order is now Redis-authoritative per `canonicalTradeId + subscriberId + channel`. Pine is unchanged.

---

## 1. Executive summary

Telegram could show TP1/TP2/TP3/SL/`KACHING TRADE COMPLETE` at the same time as ENTRY, or before ENTRY, because:

1. HTTP 202 fires **before** fan-out (`server.js` → `acceptTradingViewWebhook` → `scheduleAcceptedTradingViewSignal`).
2. Each accepted event is dispatched **independently**.
3. `claimEventId` / `claimLifecycleEvent` / `claimFanout` / `claimDelivery` prevent **duplicates**, not **order**.
4. `TradeEventDispatcher` serializes Entry → TP/SL **only on this Node process**. Two Fly machines can send TP3 while machine A’s ENTRY `sendMessage` is still in flight.
5. `entryAlreadyDurable` treated Mongo ENTRY as “already delivered.”

**Fix:** Redis delivery sequencer (`backend/utils/deliverySequencer.js`). Outcomes wait until ENTRY is **committed into that subscriber’s channel sequence** (Telegram Bot API HTTP 200). ENTRY never waits for TP/SL.

---

## 2. End-to-end trace (single trade)

Path: `POST /api/webhook/tradingview` (`backend/server.js` ~707–876)
→ `verifyTradingViewWebhook` / `assertTradingViewWebhook`
→ `TradingViewAlertService.parseWebhookBody` / `buildSignalData` (Pine compatibility)
→ `TradeEventDispatcher.withCanonicalLock`
→ `acceptAfterValidation`: realtime/freshness → `claimEventId` → `TradeLifecycleService.processIncomingTradeAlert` → persist Mongo → `markEntryReady` / `claimLifecycleEvent` / `takeOrphans`
→ HTTP **202**
→ `scheduleAcceptedTradingViewSignal` → process-local `enqueue` → `processAcceptedTradingViewSignal` → `claimFanout` → `fanOutAcceptedSignal`
→ `emitLifecycleSocket` then `TradeDeliveryService.deliverToSubscriber` (email → Telegram → MT5 → socket)

### 18 questions

| # | Question | Answer |
|---|----------|--------|
| 1 | Entry point | `server.js` POST `/api/webhook/tradingview` ~707. Accept in `acceptTradingViewWebhook` ~889. |
| 2 | eventType | Pine `eventType` or derived (`tradeEventIdentity.resolveEventTypeToken`). Compatibility in `PineCompatibilityService`. |
| 3 | eventSequence | Pine `eventSequence` or `eventSequenceFor(eventType)` (`EVENT_SEQ`: ENTRY=0, TP1=1, TP2=2, TP3/SL/EXPIRED/CANCELLED=3). |
| 4 | canonicalTradeId | Pine field, else `signalUuid` / key, else `deriveLegacyCanonicalTradeId`. Never HTTP arrival time. |
| 5 | Dup suppression | Redis `claimEventId` SET NX (`tradeEventStore.js`). Empty eventId → 409, not allow. |
| 6 | Lifecycle R/W | `TradeLifecycleService.processIncomingTradeAlert` + `SignalOutcomeService` UUID link + `applyOutcomeUpdate`. Registry is slot UX, not delivery order. |
| 7 | Redis vs Mongo | Redis: claims, locks, orphans, **delivery sequence**. Mongo Signal: durable trade document. |
| 8 | Persist before fan-out | Yes. HTTP 202 after persist. Fan-out async. |
| 9 | Concurrent processing | Canonical accept lock (Redis). Fan-out was independent per event/machine. |
| 10 | Fly races | Two machines: ENTRY on A, TP3 on B with `entryAlreadyDurable`. **Proven.** |
| 11 | Parallel fan-out | `mapWithConcurrency` (default 8) across **subscribers** of one event. Same-process dispatcher serializes events; machines do not. |
| 12 | Per-subscriber races | Until this fix, no per-subscriber/channel send lock. |
| 13 | Telegram out of order | Bot API completion order ≠ accept order when two HTTP `sendMessage` overlap. |
| 14 | TRADE COMPLETE vs TP3/SL | Same Telegram message (`SubscriberSignalFormatter.lifecycleHeadline` TP3 → `🏆 KACHING TRADE COMPLETE`). Not a separate send. |
| 15 | Downstream reconstruction | `emitLifecycleSocket` (`signal_created` / `signal_closed`). Now sequenced on `socket_lifecycle`. |
| 16 | Frontend close | `signal_closed` could emit on machine B before `signal_created` on A. Sequenced now. |
| 17 | Retry reordering | Duplicate `eventId` / lifecycle / fan-out / delivery claims skip replay. Sequencer does not put ENTRY after TP. |
| 18 | ENTRY fail + TP1 later | Outcome without parent → Redis orphan HASH. ENTRY `takeOrphans` drains. No fake ENTRY. |

**ENTRY fail + TP1 later:** TP1 is `orphaned_outcome`, stored in Redis, HTTP 202 with `pendingOutcome`. If ENTRY never arrives, Redis TTL expires the HASH (24h). Not delivered as a completed trade.

**Legacy vs 1.3.0:** Same gateway. 1.3.0 supplies `eventId`/`canonicalTradeId`. Legacy derives them. Sequencer keys on canonical id, not Pine version.

**Multi-sub / telegram+email:** Sequence is per subscriber × channel. Email and Telegram are independent sequences. Different trades use different keys (no global lock).

---

## 3. All ordering authorities (before → after)

Independent state machines found:

| Authority | File | What it decides | Delivery order? |
|-----------|------|-----------------|-----------------|
| Pine `eventSequence` | wire / compatibility | Rank hint | No |
| `claimEventId` | `tradeEventStore.js` | Exactly-once logical event | No |
| Canonical accept lock | `tradeEventDispatcher.withCanonicalLock` | Serialize persist | No |
| `TradeLifecycleService` | lifecycle stage | Accept / ignore / orphan | No |
| `applyOutcomeUpdate` | `signalOutcome.js` | No backward TP2→TP1; terminal mutex | No |
| Redis orphans | `putOrphan` / `takeOrphans` | Buffer outcomes before ENTRY exists | Accept-time only |
| `claimLifecycleEvent` | Redis SET NX | One ENTRY/TP1/… per trade | No |
| `claimFanout` | Redis SET NX | One fan-out job per event | No |
| Process-local dispatcher | `tradeEventDispatcher.js` | Same-process job queue | **Same machine only** |
| `claimDelivery` | `deliveryIdempotency.js` | One send per event×sub×channel | **Duplicates only** |
| **Delivery sequencer (new)** | `deliverySequencer.js` + Redis seq HASH/lock | Predecessor committed before send | **Yes — authority** |

**One authoritative sequencing decision:** `DeliverySequencer.withChannelSequence`. Dispatcher remains a same-process optimization. Lifecycle/orphan remain acceptance buffering. Claims remain exactly-once.

---

## 4. Invariants (1–16)

1. ENTRY first to every eligible subscriber (per channel).
2. ENTRY dispatches immediately after valid accept (HTTP 202, no wait for TP/SL).
3. TP1 never before ENTRY on that subscriber/channel.
4. TP2 never before ENTRY; never before TP1 **if TP1 was accepted**.
5. TP3 never before ENTRY. ENTRY→TP3 allowed when TP1/TP2 never accepted. No synthetic TP1/TP2.
6. SL never before ENTRY. SL does not wait for TP3 (same rank, terminal mutex).
7. EXPIRED/CANCELLED without ENTRY are orphans — not subscriber “completed trade” notices.
8. `KACHING TRADE COMPLETE` is the TP3 headline; it cannot send before ENTRY commit.
9. No completed-trade notice if that subscriber never received ENTRY on that channel.
10. Deterministic order per `canonicalTradeId + subscriberId + channel`.
11. Different trades do not share a sequence lock.
12. No duplicate milestone delivery (`claimDelivery` after sequence gate).
13. Valid outcomes are not silently dropped; pre-ENTRY orphans live in Redis (TTL 24h).
14. Redis is required in production (fail-closed). No process-local-only sequencing authority.
15. Fast ENTRY: predecessor check skipped for ENTRY.
16. Skip-milestone: wait only for **accepted** lower-rank milestones, always including ENTRY.

---

## 5. Critical race (Phase 4) — proved

TV fires ENTRY then TP1/TP2/TP3 close together.

| Question | Proof |
|----------|--------|
| 1. Fan-out fire-and-forget? | **Yes.** `scheduleAcceptedTradingViewSignal` enqueues; HTTP already 202 (`server.js` ~875). |
| 2. Each event independent? | **Yes.** Separate `processAcceptedTradingViewSignal` / `claimFanout` per alertType. |
| 3. Delivery serialized per sub/channel? | **Was no.** Now Redis `dseq:` lock + committed HASH. |
| 4. Promise.all races sends? | `mapWithConcurrency` + `Promise.all` workers across subscribers. Cross-machine `Promise.all` of two fan-outs was the bug. Test 2. |
| 5. Multi-worker same trade? | **Yes.** Fly machines; `claimFanout` is per event, not a global send lock. |
| 6. claimDelivery vs order | Prevents dup; **not** order. Claim now **after** predecessor check. |
| 7. Claim before/after ordering | **Was before.** Now after `withChannelSequence` admits the send. |
| 8. Completion while ENTRY pending | TP3 message **is** TRADE COMPLETE. Could send while ENTRY `fetch` held. Test 2/7. |
| 9. Multiple dispatchers | Process-local `states` Map per machine. Test 16 clears local queues; Redis still orders. |
| 10. Retry reorder | Duplicate claims skip. Sequencer will not commit TP before ENTRY. Test 15. |

**Do not assume Redis lifecycle (`claimLifecycleEvent` / `markEntryReady`) equals delivery order.** Those flags are set at **accept**, before Telegram.

---

## 6. ENTRY delivery semantics (chosen guarantee)

| Stage | Meaning |
|-------|---------|
| Accepted | Lifecycle + persist succeeded; HTTP 202. |
| Persisted | Mongo (or in-memory test) Signal exists. |
| Eligible | Subscriber passes tier/symbol/Telegram chat checks. |
| Claimed | `claimDelivery` SET NX — this process may send. |
| Send attempted | Bot API `sendMessage` started. |
| Successfully sent | Bot API HTTP 200 (`telegramAlertDelivered` ≈ queued at Telegram). |

**Chosen guarantee:** outcomes wait until ENTRY is **committed** on that subscriber+channel after a **successful send** (Telegram 200 = queued). Not user read receipts. Not “ENTRY accepted.” Not “fan-out claimed.”

Failed ENTRY send does **not** commit; outcomes keep waiting (cap `DELIVERY_SEQ_WAIT_MS`, default 120s production / 8s test), then buffer in Redis. Expected skips (no chatId, tier) happen **before** the sequencer; those subscribers also skip outcomes.

ENTRY is **not** held for TP.

---

## 7. Minimum fix

- **A. Acceptance** unchanged: accepted / duplicate / stale / invalid / orphan-buffered / terminal mutex.
- **B. Reused** Redis orphans + lifecycle; did not add a second trade state machine.
- **C. Outcome buffer:** existing orphan HASH; TTL raised **15s → 86400s** so delayed ENTRY retries do not drop valid TP/SL. In-process 24h `setTimeout` drop **removed** (Redis EXPIRE + ENTRY `takeOrphans` are authority).
- **D. Subscriber delivery sequencing:** Redis lock `dseq:{canonical}:{sub}:{channel}` held during send; committed HASH `kaching:trade:seqdone:…`. Outcomes poll until predecessors committed, then send.

`entryAlreadyDurable` remains a same-process hint only.

---

## 8. Observability

`logPipeline('DeliverySequence', PENDING|PASS|FAIL)` reasons include:

- `delivery_sequence_wait; predecessor=…; eventType=…; deliverySequenceKey={12-char hash}; channel=…`
- `delivery_sequence_release; eventType=…; eventSequence=…; deliverySequenceKey=…; channel=…`

Meta already carries `requestId`, `canonicalTradeId`, `eventId`, `eventType`, `eventSequence` via `extractPipelineMeta`. No secrets, Redis URLs, license tokens, or bot tokens. Sequence key is `hashIdentity`, not raw subscriber id.

---

## 9. Legacy compatibility

Compatibility gateway unchanged. Derived `canonicalTradeId` / `eventId` still feed the sequencer. Legacy `isRealtime` unknown still uses freshness windows. No Pine regenerate. No webhook URL / `{{alert_message}}` change. kls_v1/v2 unchanged.

---

## 10. Pine changes

**NO.** Backend sequencing is sufficient. Templates/snippets not modified.

---

## 11. Multi-machine safety

- Accept: Redis canonical lock + `claimEventId` (fail-closed 503).
- Fan-out: `claimFanout` (exactly-once job).
- Delivery order: Redis seq lock + committed HASH (not process memory).
- Orphans: Redis HASH shared; ENTRY `takeOrphans` on any machine.

---

## 12. Code changes

| File | Change |
|------|--------|
| `backend/utils/deliverySequencer.js` | **New.** Authoritative per-sub/channel sequence. |
| `backend/utils/tradeEventStore.js` | Seq HASH, buffer, `listAcceptedAlertTypes`; orphan TTL 24h. |
| `backend/utils/tradeEventDispatcher.js` | Comment; `resetLocalQueuesForTests`. |
| `backend/services/TradeDeliveryService.js` | Sequence telegram/email/socket **before** `claimDelivery`. |
| `backend/services/TradingViewAlertService.js` | Async sequenced `emitLifecycleSocket`; no in-process orphan drop timer. |
| `backend/services/PipelineStatusService.js` | `DeliverySequence` is not a delivery failure. |
| `backend/services/__tests__/entryFirstDeliverySequencing.test.js` | **New.** Tests 1–20 + skip-milestone invariants. |
| `backend/utils/__tests__/webhookFastAck.test.js` | Test 16: TP3 without ENTRY is not sent; TP3 after ENTRY is not formatted as BUY. |
| `backend/ENTRY_FIRST_DELIVERY_SEQUENCING_REPORT.md` | This file. |
| `backend/ENTRY_FIRST_DELIVERY_SEQUENCING_REPORT.md` | This file. |

---

## 13. Tests

See `entryFirstDeliverySequencing.test.js`:

1. Sequential ENTRY → TP1  
2. **Critical** parallel fan-out with ENTRY Telegram barrier  
3. Skip-milestone ENTRY→TP3, no synthetic TP1/TP2  
4. Orphan TP1 then ENTRY  
5. TP2 after ENTRY and TP1  
6. SL never before ENTRY  
7. TRADE COMPLETE never before ENTRY  
8. EXPIRED without ENTRY not delivered  
9. CANCELLED without ENTRY not delivered  
10. Multi-subscriber per-chat ENTRY first  
11. Two trades do not block each other  
12. Telegram + email ENTRY-first  
13. Claim after ordering  
14. Duplicate eventId  
15. Retry does not reorder  
16. Multi-machine (local queues cleared, shared fake Redis)  
17. Legacy derived identity  
18. Pine 1.3.0 native fields  
19. Redis down fail-closed (no TP3)  
20. ENTRY accept returns before Telegram; no wait for TP  

Skip-milestone documented in the invariants test: `requiredPredecessors('take_profit_3', ['entry']) === ['entry']`.

---

## 14. Remaining risks

- Telegram 200 means **queued at Telegram**, not phone display. Rare Bot API internal reordering inside one chat is outside our control; we no longer send overlapping `sendMessage` for the same chat+trade.
- If ENTRY send **fails** (network), outcomes wait then buffer; they will not appear until ENTRY succeeds or wait cap. Preferable to TP-before-ENTRY.
- Wait cap (`DELIVERY_SEQ_WAIT_MS`, 120s prod): after timeout, outcome is buffered, not sent early. A dead ENTRY fan-out still depends on `claimFanout` (pre-existing: crashed fan-out is not retried).
- `mapWithConcurrency` still parallelizes **different subscribers** of one event (correct).
- Process-local dispatcher can still delay TP until **all** subscribers finish ENTRY **on that machine**; Redis sequencer is the cross-machine guarantee.
- Known suite flake: `mt5Pairing.test.js` + `mt5ReliabilityHardening.test.js` share `backend/dev-users.json` under parallel Node test. Unrelated.

---

## 15. Validation

| Run | Result |
|-----|--------|
| `entryFirstDeliverySequencing.test.js` | **21/21 pass** (20 numbered + skip-milestone invariants). 0 fail. |
| Related: kachingAlertOnce, pineCompatibilityLayer, distributedLifecycleFix, webhookFastAck, signalOrderingStale, telegramTradeAlertDelivery | **132/132 pass** after updating fast-ack test 16. |
| `node scripts/smoke-pine-gen.js` | **ok: true**, violations 0. |
| Full `npm test` | **678 tests, 676 pass, 0 fail, 2 skipped, 0 cancelled.** Duration ~138s. Skipped: `mt5Pairing.test.js` Redis-unavailable skips (pre-existing, not pairing-weakened). MT5 pairing flake did not occur. |

No unrelated failures hidden.

---

## 16. Deployment readiness

**C. NOT SAFE TO DEPLOY** until the user approves. Production is Fly `kaching-api` **v139**. This sequencing work is local and stacked with the undeployed Pine compatibility layer.

When approved, deploy backend only after the listed tests pass. No webhook URL change. No subscriber Pine update.
