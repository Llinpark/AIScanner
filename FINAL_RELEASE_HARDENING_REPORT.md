# FINAL RELEASE HARDENING REPORT

Production was not changed. This work is local only. Do not deploy, commit, or push until the user explicitly approves.

**Production (untouched):** Fly `kaching-api` v139 / Pine 1.3.0  
**Webhook URL (unchanged):** `https://api.kachingscanner.com/api/webhook/tradingview`  
**Alert message (unchanged):** exactly `{{alert_message}}`

---

## 1. EXECUTIVE VERDICT

**NOT SAFE TO DEPLOY**

Local hardening is complete: Mongo is the durable record of delivery work, ENTRY-first still requires ENTRY delivery committed, empty `eventId` still never allows, Redis ingestion is fail-closed, and `npm test` is 0 failures. Production remains v139. Live two-machine verification has not been run. Deploy only after explicit user approval.

---

## 2. CHANGES MADE

This pass (final hardening only). Pine templates/snippets were not modified.

| File | Change |
|------|--------|
| `backend/utils/durableDelivery.js` | Mongo/`durableDocs` is the durable job store. Recovery discovers unfinished work from that store, not only Redis. Redis is cache + leases. `PROVIDER_ACCEPTED` / `SENDING` states. Structured logs. Worker Redis errors isolated. Duplicate-key re-read, not swallowed. |
| `backend/models/DeliveryJob.js` | Enum includes `sending` and `provider_accepted`. Indexes: `jobId` unique (identity), `{state, nextAttemptAt}`, `{state, leaseUntil}`, identity lookup. |
| `backend/utils/deliveryIdempotency.js` | `provider_accepted` finishes COMMITTED without a second provider send. |
| `backend/services/TradeDeliveryService.js` | `PROVIDER_SEND_STARTED` before send; `PROVIDER_ACCEPTED` immediately after provider HTTP 200, then COMMITTED. |
| `backend/services/TradingViewAlertService.js` | Duplicate `eventId` with a **missing** fan-out job recreates durable work (crash A). HTTP contract stays `duplicate: true`. Fan-out `provider_accepted` commits without re-expand. |
| `backend/services/PipelineStatusService.js` | Counts include `sending` / `provider_accepted`. `durableDeliveryWorker` last error / last tick. |
| `backend/server.js` | Eager `require('./models/DeliveryJob')` so indexes register at startup. Recovery worker still skipped when `NODE_ENV=test`. |
| `backend/.dockerignore` | Exclude `tmp-*`, audit scripts, `__tests__`, `*.test.js`, `*.cmd`, `*.hex`. |
| `backend/services/__tests__/finalReleaseHardening.test.js` | **New.** Crash A–E, Mongo-after-Redis-loss, backoff fake clock, two machines, FAILED_TERMINAL blocks TP3, worker isolation, empty eventId, 503. |
| `backend/FINAL_RELEASE_HARDENING_REPORT.md` | This file. |

Not modified in this pass: Pine templates/snippets, webhook URL, `{{alert_message}}`, M-Pesa, MT5 pairing, `LicenseTokenService`, kls_v1/kls_v2, `WEBHOOK_SIGNING_SECRET`, `TRADINGVIEW_WEBHOOK_SECRET`.

---

## 3. RED FLAG #1 STATUS

**Fixed locally.** Mongo (and the in-process `durableDocs` stand-in in tests) is the durable record that delivery work exists. Redis is not the only long-term store.

| Requirement | Status |
|-------------|--------|
| Canonical accepted event persisted | Unchanged: Signal persist before 202 |
| Durable delivery work created idempotently before HTTP 202 | `ensureFanoutWork` still runs before accept returns |
| Job survives process / Fly / deploy / Redis restart / lease expiry | Redis restart test reloads from durable store; expired PROCESSING/SENDING leases are reclaimed |
| Redis leases coordinate ownership | SET NX `kaching:trade:dlease:{jobId}` |
| Mongo records durable delivery state | Awaited upsert on ingest when Mongo is connected; `jobId` unique |
| Recovery worker discovers unfinished work from Mongo | `listJobIdsFromMongo` / `durableDocs`; Redis index is optional cache. `setInterval` is only a trigger |

Crash after persist+claim and **before** `ensureFanoutWork`: TradingView retry sees duplicate `eventId`. If the fan-out job is missing, it is recreated. HTTP remains duplicate/idempotent 202. The recovery worker processes the new PENDING job. Job existing ≠ DELIVERED.

Duplicate-key: E11000 is re-read and classified already-exists vs already-delivered. It is not swallowed.

---

## 4. RED FLAG #2 STATUS

**Still held.** Outcomes wait for ENTRY **delivery COMMITTED** (provider success + durable COMMITTED), not webhook accept, not fan-out claim, not a job merely existing.

| Case | Result |
|------|--------|
| ENTRY fail | TP3 stays `blocked_waiting_for_entry` / not delivered |
| Retry ENTRY success | `onEntryCommitted` unblocks outcomes; TP3 may send after ENTRY |
| ENTRY `failed_terminal` | TP3 stays blocked |
| Admin `retryFailedTerminal` then ENTRY success | ENTRY sends first; TP3 cannot overtake |

No fake TP milestones. Skip-milestone ENTRY→TP3 remains allowed only when TP1/TP2 were never accepted.

---

## 5. PROVIDER SUCCESS / CRASH WINDOW

Telegram Bot API used: `POST https://api.telegram.org/bot{token}/sendMessage` with `{ chat_id, text, parse_mode, disable_web_page_preview }`.

**No provider idempotency key exists** for this integration. Telegram has no `Idempotency-Key` / client request id on `sendMessage`. This system is **at-least-once** at the Telegram boundary. Do not claim exactly-once.

`SENDING` and `PROVIDER_ACCEPTED` were added because they shrink the duplicate window and each has a recovery path:

- Expired `SENDING` → reclaim lease → resend (at-least-once)
- `PROVIDER_ACCEPTED` → COMMITTED without resend
- Never stuck: both states are due for the worker

| Crash | Semantics | Duplicate possible? |
|-------|-----------|---------------------|
| **A** persist, before `ensureFanoutWork` | TV retry recreates missing job; worker delivers | No extra Signal; one fan-out job |
| **B** durable work, before HTTP 202 | Worker processes existing job | No second job |
| **C** fan-out/delivery lease, before send | Lease expires; other machine sends once | At-least-once until COMMITTED (usually one send) |
| **D** Telegram HTTP 200, before `PROVIDER_ACCEPTED` persist | Retry **resends** | **Yes — at-least-once** |
| **D2** `PROVIDER_ACCEPTED`, before COMMITTED | Finish commit; **no resend** | No |
| **E** after COMMITTED, duplicate webhook | App-layer suppress | No (exactly-once at app layer only) |

Honest summary: **at-least-once**. The remaining duplicate window is Telegram 200 → durable `PROVIDER_ACCEPTED` write. After that, recovery does not resend.

---

## 6. DURABILITY MODEL

```
HTTP accept
  → persist Signal
  → ensureFanoutWork (Mongo durable job PENDING)     [before 202]
  → HTTP 202
  → async / recovery worker
       → Redis SET NX lease
       → PROCESSING → SENDING → provider HTTP
       → PROVIDER_ACCEPTED (durable write)
       → sequencer commit (ENTRY unblocks outcomes)
       → COMMITTED / DELIVERED
```

| Store | Role |
|-------|------|
| **Mongo `delivery_jobs`** | Durable record that work exists and its state. Source of truth for recovery discovery. |
| **Redis job JSON + index** | Optional cache, 7-day TTL. Loss is recoverable from Mongo. |
| **Redis lease** | Ownership only. Expires. Not a completion record. |
| **Recovery worker** | `setInterval` trigger (unref’d). Scans Mongo/durable unfinished: PENDING, RETRY_PENDING due, BLOCKED due, PROVIDER_ACCEPTED, PROCESSING/SENDING with expired lease. Disabled when `NODE_ENV=test`. Does not block `/health`. |

Ingestion without Redis: fail-closed (no process-local authority). Ingestion without Mongo in production: fail-closed on job create. Worker Redis errors: log, expose on `durableDeliveryWorker`, retry next tick; **do not crash the API process**.

---

## 7. ENTRY-FIRST GUARANTEE

Outcomes unblock only when ENTRY is **COMMITTED** on that `canonicalTradeId + subscriberId + channel`:

1. Provider success (Telegram HTTP 200 ≈ queued at Telegram, not phone display)
2. Durable job `PROVIDER_ACCEPTED` then `DELIVERED`
3. Sequencer `markDeliveryCommitted` + `onEntryCommitted`

Not sufficient: webhook 202, `claimEventId`, fan-out lease, job document existing, Mongo Signal existing.

ENTRY never waits for TP/SL.

---

## 8. MULTI-MACHINE SAFETY

| # | Scenario | Result |
|---|---------|--------|
| 1 | Two owners, one job | One `LEASE_ACQUIRED`, one `LEASE_BUSY` |
| 2 | Busy owner | Does not send |
| 3 | Lease expiry | Other machine `RECOVERED` |
| 4 | Delivered | `beginAttempt` returns `delivered`; never reprocessed |
| 5 | Backoff | `RETRY_PENDING` with `nextAttemptAt`; `not_due` until fake clock advances |
| 6 | BLOCKED outcomes | Cannot overtake ENTRY |
| 7 | `FAILED_TERMINAL` | Visible; explicit `retryFailedTerminal` only |
| 8 | Redis restart | Durable job remains; fly-2 can acquire |
| 9 | Duplicate webhook | Same `jobId`; no second Telegram after COMMITTED |
| 10 | Redis down on ingest | HTTP 503 `redis_unavailable`; no process-local claim |

`TradeEventDispatcher` remains process-local (same-process optimization only). Cross-machine authority is Redis sequencer + durable jobs + leases.

---

## 9. RELEASE MANIFEST

Proposed **backend** image contents (runtime). Tests and temp files must stay out of the image.

| FILE | REQUIRED FOR RELEASE | REASON | ACTION |
|------|---------------------|--------|--------|
| `backend/server.js` | YES | Boot, webhook, recovery worker | KEEP |
| `backend/package.json` / `package-lock.json` | YES | Runtime deps | KEEP |
| `backend/Dockerfile` / `fly.toml` | YES | Fly image | KEEP |
| `backend/.env.example` | YES | Documents `DELIVERY_*` (no secrets) | KEEP |
| `backend/utils/durableDelivery.js` | YES | Durable state machine | KEEP |
| `backend/models/DeliveryJob.js` | YES | Mongo durable jobs | KEEP |
| `backend/models/Signal.js` | YES | Canonical event persist | KEEP |
| `backend/utils/deliverySequencer.js` | YES | ENTRY-first | KEEP |
| `backend/utils/deliveryIdempotency.js` | YES | Lease vs commit | KEEP |
| `backend/utils/tradeEventStore.js` | YES | Redis claims / seq HASH | KEEP |
| `backend/utils/tradeEventIdentity.js` | YES | Identity | KEEP |
| `backend/utils/tradeEventDispatcher.js` | YES | Same-process queue only | KEEP |
| `backend/services/TradingViewAlertService.js` | YES | Gateway + fan-out | KEEP |
| `backend/services/TradeDeliveryService.js` | YES | Telegram/email send | KEEP |
| `backend/services/PineCompatibilityService.js` | YES | Legacy/1.2/1.3 adapters | KEEP |
| `backend/config/PineCompatibilityRegistry.js` | YES | Adapter selection | KEEP |
| `backend/contracts/KachingTradeEvent.js` | YES | Canonical contract | KEEP |
| `backend/services/PipelineStatusService.js` | YES | Observability | KEEP |
| `backend/config/` `middleware/` `routes/` `strategies/` `templates/` `validators/` | YES | Existing runtime | KEEP |
| `backend/templates/*.pine.template` + snippets | YES | Generator (this pass did not edit) | KEEP — do not regen subscribers |
| `**/__tests__/**` `*.test.js` | NO | Tests | EXCLUDE (dockerignore) |
| `backend/*_REPORT.md` | NO | Docs | EXCLUDE (`*.md`) |
| `backend/deploy-out*.txt` | NO | Generated logs | EXCLUDE |
| `backend/tmp-*` `scripts/_tmp_*` `scripts/_run_audit_*` | NO | Debug | EXCLUDE |
| `frontend/**` | NO | Pages deploy, not this image | EXCLUDE |
| `scripts/clear-pipeline-status-redis.js` | NO | Ops | REVIEW / still not dockerignored individually |
| `scripts/revoke-duplicate-mpesa.fly.js` | NO | Ops | REVIEW / still not dockerignored individually |

---

## 10. WORKING TREE AUDIT

The tree is dirty with stacked undeployed work plus temp artifacts. **Nothing was deleted, reset, stashed, or committed.**

Legend: A required release · B dependency · C unrelated · D temp/debug · E generated · F accidental

| FILE / GROUP | STATUS | WHY CHANGED | REQUIRED FOR RELEASE | ACTION |
|--------------|--------|-------------|----------------------|--------|
| `durableDelivery.js`, `DeliveryJob.js`, sequencer, Pine compat, TradingViewAlertService, TradeDeliveryService, tradeEvent* | A | This stack (compat + ENTRY-first + durable + this pass) | YES | KEEP |
| `server.js`, `PipelineStatusService.js`, `.env.example`, `fly.toml` | A | Worker boot / env / Fly | YES | KEEP |
| `.dockerignore` | A | Stop temp files entering the image | YES | KEEP |
| Pine templates/snippets (git `M`) | A | **Pre-existing 1.3.0 foundation — not edited this pass** | YES | KEEP; do not change again |
| `LicenseTokenService.js` / license tests | A | Pre-existing CR transport normalize | YES | KEEP; not touched this pass |
| `frontend/src/components/{Checkout,ManualMpesaCheckout,Pricing}.jsx` | C | Checkout/pricing UI | NO for API image | KEEP in repo; Pages separately |
| `backend/routes/auth.js` | C | Auth/checkout backend | REVIEW | REVIEW |
| `deploy-out*.txt` (~45) | E | Prior deploy logs | NO | EXCLUDE |
| `scripts/_tmp_*`, `_run_audit_*`, `_run_prod_*` | D | Audits | NO | EXCLUDE |
| `tmp-audit-tvwh.js`, `tmp-fly-*` | D | Debug | NO | EXCLUDE (now dockerignored) |
| `tmp-optiona-smoke-pine/` | D | Smoke artifacts | NO | EXCLUDE |
| `frontend/dist/**` | E | Pages build | NO | Separate deploy |
| `tmp-mpesa-backend.zip`, `u.telegram` | F | Accidental | NO | EXCLUDE |
| `python-service/deploy-out.txt` | E | Other service | NO | EXCLUDE |

**Docker:** `COPY . .` from `backend/`. Previously untracked temp files **could** enter the image. This pass added ignore rules for `tmp-*`, tests, audit `.cmd`. Remaining image extras if present: `scripts/clear-pipeline-status-redis.js`, `scripts/revoke-duplicate-mpesa.fly.js` (inert at runtime). Secrets (`.env*`) already ignored.

---

## 11. TEST RESULTS

| Run | Result |
|-----|--------|
| `finalReleaseHardening.test.js` | **16/16 pass**, 0 fail, 0 skipped |
| `durableDeliveryRecovery.test.js` | **17/17 pass**, 0 fail, 0 skipped |
| Related: hardening + durable + `entryFirstDeliverySequencing` + `pineCompatibilityLayer` + `kachingAlertOnce` + `distributedLifecycleFix` + `webhookFastAck` + `telegramTradeAlertDelivery` | **155/155 pass**, 0 fail, 0 skipped |
| `cmd /c "set NODE_ENV=test&& node scripts/smoke-pine-gen.js"` | **ok: true**, violations **0** |
| Full `npm test` | **711 tests, 153 suites, 709 pass, 0 fail, 2 skipped, 0 todo** (~141s) |

Skipped (pre-existing, Redis not available in this environment; MT5 pairing not weakened; **no new skips**):

- `stores and atomically consumes PairCode via Redis GETDEL when available`
- `concurrent Redis completePairing yields a single winner`

No assertions were weakened. No tests were skipped to go green. Known flake (`mt5Pairing.test.js` + `mt5ReliabilityHardening.test.js` sharing `dev-users.json`) **did not occur**.

Delta vs prior durable report (695 tests / 693 pass / 2 skipped): **+16 tests**, all new hardening cases.

---

## 12. REMAINING RISKS

| Level | Risk |
|-------|------|
| **HIGH** | At-least-once window: crash after Telegram HTTP 200 and before durable `PROVIDER_ACCEPTED`. Subscriber can receive a duplicate message. Telegram cannot make this exactly-once. |
| **HIGH** | Working tree is dirty with unrelated/untracked files. A naive `fly deploy` from `backend/` still copies everything not dockerignored. Use the release manifest; do not deploy the whole dirty tree blindly. |
| **MEDIUM** | This stacks with other undeployed local work (Pine compatibility, ENTRY-first, checkout/pricing). Review the deploy set before approval. |
| **MEDIUM** | `TradeEventDispatcher` is process-local. Cross-machine order depends on Redis sequencer + durable jobs (tested). |
| **MEDIUM** | Outcome `seqbuf` / BLOCKED jobs created by sequencer timeout may lack a full subscriber snapshot; worker then retries with `missing_channel_payload` until a path that has subscriber payload runs. ENTRY-first still holds (TP3 will not send first). |
| **LOW** | Telegram 200 = queued at Telegram, not phone display. |
| **LOW** | Redis job cache TTL 7 days is irrelevant for durability now (Mongo holds the record). |
| **LOW** | Ops scripts `clear-pipeline-status-redis.js` / `revoke-duplicate-mpesa.fly.js` can still enter the image if present; not executed at startup. |
| **LOW** | Known parallel-test flake on `dev-users.json` (MT5 pairing). Unrelated. |

No remaining **BLOCKER** in code for Mongo source of truth, empty eventId allow, ENTRY-first, Redis process-local fallback, or failing tests.

---

## 13. DEPLOYMENT PLAN

Do not run these until the user explicitly approves.

1. Confirm this report and the 15-section verdict.
2. Deploy **backend only** (`kaching-api`). Do not change webhook URL. Do not rotate secrets. Do not require Pine regen.
3. Build from `backend/` with the updated `.dockerignore`. Do not copy `tmp-*`, tests, or `deploy-out*`.
4. Keep Fly scale at **two machines**.
5. Env (defaults exist; set if overriding):

```
DELIVERY_MAX_ATTEMPTS=8
DELIVERY_RETRY_BASE_DELAY_MS=500
DELIVERY_RETRY_MAX_DELAY_MS=60000
DELIVERY_PROCESSING_LEASE_MS=120000
DELIVERY_RECOVERY_INTERVAL_MS=2000
DELIVERY_SEQ_WAIT_MS=120000
```

6. Confirm Mongo `delivery_jobs` collection and unique `jobId` index after boot.
7. Confirm Redis still required (fail-closed 503 if down).
8. Confirm recovery worker logs on both machines (`DELIVERY_JOB_CREATED` / `LEASE_ACQUIRED` / `LEASE_BUSY`).
9. Run the **live verification checklist** below on production after deploy.
10. Watch PipelineStatus: `pending` / `processing` / `sending` / `retry_pending` / `provider_accepted` / `delivered` / `failed_terminal` / `blocked_waiting_for_entry`.

### Live verification checklist (tests 1–10)

Do this on production only after approval. Do not use this pass to deploy.

1. **ENTRY webhook** → HTTP 202, durable fan-out job exists, Telegram ENTRY arrives, job `delivered`.
2. **Duplicate same ENTRY** → 202 duplicate, **no** second Telegram.
3. **TP3 shortly after ENTRY** → Telegram order is ENTRY then TP3 / TRADE COMPLETE. Never TP3 first.
4. **TP3 with ENTRY never delivered** (force ENTRY send fail) → no TRADE COMPLETE; TP3 blocked.
5. **ENTRY retry then TP3** → ENTRY then TP3.
6. **Redis bounce** (or failover) → unfinished jobs still recovered from Mongo; no process-local allow.
7. **Redis down** → webhook **503** `redis_unavailable`; no silent local claim.
8. **One Fly machine stop** mid-send → other machine reclaims expired lease; no permanent loss.
9. **Both machines up**, same trade → one lease winner; `LEASE_BUSY` on the other.
10. **Legacy (no pineClientVersion) and 1.3.0** ENTRY both 202 and deliver; no subscriber Pine regen.

---

## 14. ROLLBACK PLAN

Back to current production **Fly `kaching-api` v139**.

1. `fly deploy` / `fly releases rollback` to the v139 image (operator action after approval to roll back).
2. Do not change webhook URL or Pine. Subscribers keep 1.3.0 / legacy scripts.
3. Mongo `delivery_jobs` documents from the new image are unused by v139 (v139 does not read them). They are inert leftover rows; do not drop unless ops explicitly wants cleanup.
4. Redis keys `kaching:trade:djob:*` / `dlease:*` / `djobidx` can expire via TTL; v139 does not require them.
5. Do not rotate `WEBHOOK_SIGNING_SECRET` or Telegram token as part of rollback.

---

## 15. SUBSCRIBER IMPACT

**NO subscriber action required.**

- No Pine regeneration
- No alert recreation
- Webhook URL unchanged
- `{{alert_message}}` unchanged
- kls_v1 and kls_v2 unchanged
- Existing unknown / 1.2.x / 1.3.0 scripts keep working through the compatibility gateway

Exception: none genuine. Old chart drawings on 1.2.x cannot be fixed remotely (pre-existing; not introduced here).

---

## Observability (this pass)

Structured `[DURABLE DELIVERY]` / `[PIPELINE] DurableDelivery` fields (ids hashed; never secrets/tokens):

`requestId`, `eventId`, `canonicalTradeId`, `eventType`, `eventSequence`, `subscriberId` (hash), `channel`, `deliveryJobId` (hash), `attemptCount`, `sendAttempts`, lease owner hash / `leaseUntil`, `state`, retry reason.

State transition names:

`DELIVERY_JOB_CREATED`, `LEASE_ACQUIRED`, `LEASE_BUSY`, `PROVIDER_SEND_STARTED`, `PROVIDER_ACCEPTED`, `COMMITTED`, `RETRY_SCHEDULED`, `BLOCKED_WAITING_FOR_ENTRY`, `RECOVERED`, `FAILED_TERMINAL`.

PipelineStatus keeps and extends:

`pending`, `processing`, `sending`, `retry_pending`, `provider_accepted`, `delivered`, `failed_terminal`, `blocked_waiting_for_entry`.

---

**STOP. Not deployed. Not committed. Not pushed.**
