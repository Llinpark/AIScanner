# FINAL RELEASE SAFETY AUDIT

**Date:** 2026-08-25  
**Scope:** Local release candidate vs production Fly `kaching-api` **v139** / Pine **1.3.0**  
**Webhook URL (unchanged):** `https://api.kachingscanner.com/api/webhook/tradingview`  
**Alert message (unchanged):** exactly `{{alert_message}}`

This audit did **not** deploy, commit, push, reset, stash, delete working files, modify Pine templates/snippets, rotate secrets, or add architecture.

**Docker:** `docker` is not installed on this machine. Build context was proven by parsing `backend/.dockerignore` and listing files that `COPY . .` would include. `docker build --dry-run` was not available.

---

## 1. EXECUTIVE VERDICT

**CONDITIONAL GO — SAFE FOR CONTROLLED DEPLOYMENT** after the operator accepts the co-ship list in section 11.

The delivery release candidate (COMPAT + ENTRY-first + durable recovery + hardening) is internally consistent, covered by tests, and the **Docker build context is safe**: tests, reports, `tmp-*`, `deploy-out*`, audit scripts, and `.env` secrets are excluded. Required runtime files (including previously untracked `DeliveryJob.js`, `durableDelivery.js`, Pine compatibility modules) **will** enter the image.

This is **not** a code NO-GO. Remaining conditions are operational, not missing delivery architecture:

1. A naive `fly deploy` from `backend/` ships **unrelated** local runtime diffs in the same image (pricing USD conversion, mailer quota circuit, Binance amount lock, auth quota copy, `fly.toml` `EMAIL_TRADE_ALERTS_ENABLED`).
2. Frontend Checkout/Pricing is **not** in this image. If USDT display must match the new `priceCents`, Pages must be deployed in the same window.
3. Live two-machine production checks 1–13 have not been run (cannot without deploy).

Honest delivery semantics: **at-least-once** at the Telegram boundary. Crash after Telegram HTTP 200 and before durable `PROVIDER_ACCEPTED` can duplicate one message. This integration has **no** `sendMessage` idempotency key.

**No subscriber Pine regeneration. No webhook URL change. No secret rotation.**

---

## 2. RELEASE MANIFEST TABLE

Legend: **A** RELEASE_REQUIRED · **B** RELEASE_SUPPORTING · **C** TEST_ONLY · **D** AUDIT_ONLY · **E** TEMPORARY · **F** UNRELATED

`INCLUDED IN DOCKER IMAGE?` is from the `.dockerignore` simulation (206 files would be sent). Frontend is outside the backend build context.

| FILE | STATUS | WHY IT EXISTS | REQUIRED IN PRODUCTION? | INCLUDED IN DOCKER IMAGE? | ACTION |
|------|--------|---------------|-------------------------|---------------------------|--------|
| `backend/server.js` | A | Webhook 202, eager `DeliveryJob` require, recovery worker boot | YES | YES | KEEP |
| `backend/Dockerfile` | A | Fly image (`COPY . .`) | YES | YES | KEEP |
| `backend/.dockerignore` | A | Stops tmp/tests/audit entering the image | YES (build) | YES | KEEP |
| `backend/fly.toml` | A + F | App config; this diff also adds `EMAIL_TRADE_ALERTS_ENABLED` and drops `SCANNER_AUTO_ENABLED` from `[env]` (code default remains ON) | YES | YES | KEEP; confirm env co-ship |
| `backend/package.json` | A | Runtime deps (no new packages for this stack) | YES | YES | KEEP |
| `backend/package-lock.json` | A | `npm ci --omit=dev` | YES | YES | KEEP |
| `backend/.env.example` | B | Documents `DELIVERY_*` (no secrets) | Docs only | YES (`!.env.example`) | KEEP |
| `backend/models/DeliveryJob.js` | A | Mongo `delivery_jobs` durable store | YES | YES | KEEP |
| `backend/models/Signal.js` | A | `deliveredKeys`, identity/event fields | YES | YES | KEEP |
| `backend/utils/durableDelivery.js` | A | State machine, Mongo source of truth, leases, worker | YES | YES | KEEP |
| `backend/utils/deliverySequencer.js` | A | ENTRY-first per subscriber/channel | YES | YES | KEEP |
| `backend/utils/deliveryIdempotency.js` | A | Lease vs COMMITTED; `provider_accepted` no resend | YES | YES | KEEP |
| `backend/utils/tradeEventStore.js` | A | Redis claims, seq HASH, empty eventId throw, fail-closed | YES | YES | KEEP |
| `backend/utils/tradeEventDispatcher.js` | A | Same-process queue only | YES | YES | KEEP |
| `backend/utils/tradeEventIdentity.js` | A | Canonical id / eventId / freshness | YES | YES | KEEP |
| `backend/utils/PineClientVersion.js` | A | Stamp still `1.3.0` + `stable-v1` constant | YES | YES | KEEP |
| `backend/utils/pipelineLog.js` | B | Compatibility + delivery observability | YES | YES | KEEP |
| `backend/utils/pipelineObservability.js` | B | Pipeline stamps | YES | YES | KEEP |
| `backend/utils/pipelineSelfTest.js` | B | Dev self-test (gated off in production) | NO (prod path) | YES | KEEP; inert in prod |
| `backend/utils/activeSignalRegistry.js` | B | Slot UX, not delivery order | YES | YES | KEEP |
| `backend/services/TradingViewAlertService.js` | A | Gateway, always `claimEventId`, `ensureFanoutWork` before 202 | YES | YES | KEEP |
| `backend/services/TradeDeliveryService.js` | A | SENDING → provider → PROVIDER_ACCEPTED → COMMITTED | YES | YES | KEEP |
| `backend/services/TradeLifecycleService.js` | A | Accept / orphan / terminal mutex | YES | YES | KEEP |
| `backend/services/PineCompatibilityService.js` | A | Legacy / 1.2 / 1.3 / stable adapters | YES | YES | KEEP |
| `backend/config/PineCompatibilityRegistry.js` | A | Adapter selection | YES | YES | KEEP |
| `backend/contracts/KachingTradeEvent.js` | A | Canonical contract | YES | YES | KEEP |
| `backend/services/PipelineStatusService.js` | B | Counts include `sending` / `provider_accepted` | YES | YES | KEEP |
| `backend/services/SignalOutcomeService.js` | B | Outcome linking | YES | YES | KEEP |
| `backend/services/SubscriberSignalFormatter.js` | B | Canonical levels after gateway | YES | YES | KEEP |
| `backend/services/LicenseTokenService.js` | A | kls_v1 verify + kls_v2 mint; outer CR trim only | YES | YES | KEEP |
| `backend/services/PineScriptGeneratorService.js` | B | Generator copy for 1.3.0; webhook still from `WEBHOOK_TRADINGVIEW_URL` | YES (new gens) | YES | KEEP; do not regen subscribers |
| `backend/templates/kaching-sweep-fvg-*.pine.template` | A | Existing 1.3.0 foundation (not edited this audit) | YES (generator) | YES | KEEP; **do not change** |
| `backend/templates/snippets/kaching-canon-event-arm.pine.snippet` | A | Sole `alert()` | YES | YES | KEEP; **do not change** |
| `backend/templates/snippets/kaching-trade-drawing.pine.snippet` | A | 1.3.0 drawings | YES | YES | KEEP; **do not change** |
| `backend/templates/snippets/kaching-trade-drawing-runtime.pine.snippet` | A | Drawing runtime | YES | YES | KEEP; **do not change** |
| `backend/tradingview-bot.pine` (deleted vs HEAD) | F | Unused; no remaining require | NO | NO (absent) | Do not restore |
| `backend/tradingview-pine-script.pine` (deleted vs HEAD) | F | Unused | NO | NO (absent) | Do not restore |
| `backend/scripts/smoke-pine-gen.js` | C | Generator smoke | NO | YES (ops script) | KEEP local; not executed at boot |
| `backend/config/subscriptions.js` | F | KES→USD 130 `priceCents` | Not this stack | YES | Co-ships if you deploy |
| `backend/routes/auth.js` | F | Mail quota user copy | Not this stack | YES | Co-ships if you deploy |
| `backend/services/ActivationService.js` | F | Binance amount must match plan USDT | Not this stack | YES | Co-ships if you deploy |
| `backend/utils/mailer.js` | F | Bulk quota circuit; `EMAIL_TRADE_ALERTS_ENABLED` | Not this stack | YES | Co-ships if you deploy |
| `backend/scripts/fly-secrets-import.ps1` | F | Secrets import helper | NO | YES | Inert at boot |
| `backend/scripts/fly-secrets.example.env` | B | Placeholder env names only (empty secrets) | NO | YES | No real secrets in diff |
| `frontend/src/components/Checkout.jsx` | F | USDT fallback | NO for API | NO | Separate Pages deploy |
| `frontend/src/components/ManualMpesaCheckout.jsx` | F | USDT from KES/130 | NO for API | NO | Separate Pages deploy |
| `frontend/src/components/Pricing.jsx` | F | USDT meta line | NO for API | NO | Separate Pages deploy |
| `backend/services/__tests__/finalReleaseHardening.test.js` | C | Crash A–E, 503, two machines | NO | NO | EXCLUDED |
| `backend/services/__tests__/durableDeliveryRecovery.test.js` | C | Durable recovery A–P | NO | NO | EXCLUDED |
| `backend/services/__tests__/entryFirstDeliverySequencing.test.js` | C | ENTRY-first 1–20 | NO | NO | EXCLUDED |
| `backend/utils/__tests__/pineCompatibilityLayer.test.js` | C | Compat A–J | NO | NO | EXCLUDED |
| `backend/utils/__tests__/kachingAlertOnce.test.js` | C | Exactly-once alerts | NO | NO | EXCLUDED |
| `backend/utils/__tests__/distributedLifecycleFix.test.js` | C | Distributed lifecycle | NO | NO | EXCLUDED |
| `backend/utils/__tests__/webhookFastAck.test.js` | C | Fast-ack 202 | NO | NO | EXCLUDED |
| `backend/services/__tests__/telegramTradeAlertDelivery.test.js` | C | Telegram gates | NO | NO | EXCLUDED |
| `backend/services/__tests__/licenseTokenService.test.js` | C | kls_v1/v2 CR | NO | NO | EXCLUDED |
| `backend/services/__tests__/activationService.logic.test.js` | C | Activation / 503 | NO | NO | EXCLUDED |
| `backend/services/__tests__/subscriberSignalFormatter.test.js` | C | Formatter | NO | NO | EXCLUDED |
| `backend/utils/__tests__/optionACanonicalTf.test.js` | C | Canonical TF | NO | NO | EXCLUDED |
| `backend/utils/__tests__/optionAEventBridge.test.js` | C | Event bridge | NO | NO | EXCLUDED |
| `backend/utils/__tests__/phase16PreDeployValidation.test.js` | C | Pre-deploy gate | NO | NO | EXCLUDED |
| `backend/utils/__tests__/pineClientArchitecture.test.js` | C | Client stamp | NO | NO | EXCLUDED |
| `backend/utils/__tests__/kachingDrawingLifecycle.test.js` | C | Drawings | NO | NO | EXCLUDED |
| `backend/utils/__tests__/mailerQuota.test.js` | C | Mailer circuit | NO | NO | EXCLUDED |
| `backend/utils/__tests__/signalOrderingStale.test.js` | C | Stale ordering | NO | NO | EXCLUDED |
| `backend/PINE_COMPATIBILITY_ARCHITECTURE_REPORT.md` | D | Prior architecture record | NO | NO (`*.md`) | KEEP in repo |
| `backend/ENTRY_FIRST_DELIVERY_SEQUENCING_REPORT.md` | D | Prior sequencing record | NO | NO | KEEP in repo |
| `backend/DURABLE_DELIVERY_RECOVERY_REPORT.md` | D | Prior durable record | NO | NO | KEEP in repo |
| `backend/FINAL_RELEASE_HARDENING_REPORT.md` | D | Prior hardening record | NO | NO | KEEP in repo |
| `backend/FINAL_RELEASE_SAFETY_AUDIT.md` | D | This audit | NO | NO | KEEP in repo |
| `backend/scripts/clear-pipeline-status-redis.js` | E | Ops | NO | YES | Inert at boot |
| `backend/scripts/revoke-duplicate-mpesa.fly.js` | E | Ops | NO | YES | Inert at boot |
| `python-service/deploy-out.txt` | E | Other service log | NO | NO (not in backend context) | Ignore |
| `tmp-mpesa-backend.zip` | E | Accidental archive | NO | NO | Ignore; do not delete |
| `u.telegram` | E | Accidental | NO | NO | Ignore; do not delete |

**TEMPORARY untracked (all EXCLUDED from image by `.dockerignore`; do not delete):**

`backend/deploy-out.txt`, `backend/deploy-out-audit-admin-stats-gap.txt`, `backend/deploy-out-audit-db-inventory.txt`, `backend/deploy-out-audit-pipeline-status.txt`, `backend/deploy-out-audit-tg-eligibility.txt`, `backend/deploy-out-fly-manual-binance.txt`, `backend/deploy-out-fly-optiona.txt`, `backend/deploy-out-fly-telegram-only.txt`, `backend/deploy-out-fly-webhook-pipeline-hotfix.txt`, `backend/deploy-out-fly-webhook-pipeline.txt`, `backend/deploy-out-fly-webhook-placeholder.txt`, `backend/deploy-out-frontend-build-binance.txt`, `backend/deploy-out-frontend-build-pipeline-isolation.txt`, `backend/deploy-out-frontend-build-webhook-fix.txt`, `backend/deploy-out-frontend-build.txt`, `backend/deploy-out-frontend-pages-binance.txt`, `backend/deploy-out-frontend-pages-pipeline-isolation.txt`, `backend/deploy-out-frontend-pages-webhook-fix.txt`, `backend/deploy-out-frontend-pages.txt`, `backend/deploy-out-full-suite-webhook-fix.txt`, `backend/deploy-out-kaching.txt`, `backend/deploy-out-lifecycle-issues.txt`, `backend/deploy-out-npm-test-compat.txt`, `backend/deploy-out-npm-test-event-bridge.txt`, `backend/deploy-out-npm-test-local.txt`, `backend/deploy-out-npm-test-optiona-final.txt`, `backend/deploy-out-npm-test.txt`, `backend/deploy-out-option-a-npm-test.txt`, `backend/deploy-out-phase16-tests.txt`, `backend/deploy-out-pine-test.txt`, `backend/deploy-out-pipeline-isolation-fly.txt`, `backend/deploy-out-pipeline-isolation-tests.txt`, `backend/deploy-out-predeploy-gate.txt`, `backend/deploy-out-predeploy-optiona-gate.txt`, `backend/deploy-out-predeploy-optiona-npm.txt`, `backend/deploy-out-predeploy-optiona-smoke.txt`, `backend/deploy-out-presmoke-npm.txt`, `backend/deploy-out-presmoke-smoke.txt`, `backend/deploy-out-sl-replace.txt`, `backend/deploy-out-smoke-optiona-final.txt`, `backend/deploy-out-smoke-pine-phase16.txt`, `backend/deploy-out-smoke-pine.txt`, `backend/deploy-out-stable-pine.txt`, `backend/deploy-out-telegram-only-tests.txt`, `backend/deploy-out-telegram-only-tests2.txt`, `backend/deploy-out-tf-indep.txt`, `backend/deploy-out-tv-webhook-logs.txt`, `backend/deploy-out-webhook-placeholder-tests.txt`

`backend/tmp-audit-tvwh.js`, `backend/tmp-fly-gql-out.txt`, `backend/tmp-fly-gql.json`, `backend/tmp-fly-logs-http.txt`, `backend/tmp-fly-logs-json.txt`, `backend/tmp-fly-logs-notail.txt`

`backend/scripts/_run_audit_admin_stats_gap.cmd`, `backend/scripts/_run_audit_auth_fail_v7toi.cmd`, `backend/scripts/_run_audit_db_inventory.cmd`, `backend/scripts/_run_audit_pipeline_status.cmd`, `backend/scripts/_run_audit_tg_eligibility.cmd`, `backend/scripts/_run_audit_tv_drawings.cmd`, `backend/scripts/_run_prod_direction_audit.cmd`, `backend/scripts/_run_prod_mongo_direction_audit.cmd`, `backend/scripts/_run_prod_telegram_audit.cmd`, `backend/scripts/_run_prod_telegram_audit2.cmd`, `backend/scripts/_run_prod_telegram_audit3.cmd`, `backend/scripts/_run_prod_telegram_audit4.cmd`, `backend/scripts/_sftp_put_tg.txt`

`backend/scripts/_tmp_audit_active_vs_payments.js`, `backend/scripts/_tmp_audit_admin_stats_gap.hex`, `backend/scripts/_tmp_audit_admin_stats_gap.js`, `backend/scripts/_tmp_audit_auth_fail_v7toi.js`, `backend/scripts/_tmp_audit_db_inventory.js`, `backend/scripts/_tmp_audit_license_token.js`, `backend/scripts/_tmp_audit_mpesa_dup.js`, `backend/scripts/_tmp_audit_mpesa_dup.local.js`, `backend/scripts/_tmp_audit_pipeline_status.js`, `backend/scripts/_tmp_audit_tg_eligibility.js`, `backend/scripts/_tmp_audit_tv_drawings.js`, `backend/scripts/_tmp_confirm_isolation.js`, `backend/scripts/_tmp_gucha_third.js`, `backend/scripts/_tmp_pipeline_users_diag.js`, `backend/scripts/_tmp_prod_db_inventory.js`, `backend/scripts/_tmp_prod_db_list.js`, `backend/scripts/_tmp_prod_direction_audit.js`, `backend/scripts/_tmp_prod_pipeline_probe.js`, `backend/scripts/_tmp_prod_signals_probe.js`, `backend/scripts/_tmp_prod_telegram_audit.js`, `backend/scripts/_tmp_signal_count.js`, `backend/scripts/_tmp_verify_mpesa_after.js`, `backend/scripts/tmp_prod_telegram_audit.js`

---

## 3. DOCKER BUILD CONTEXT RESULT

**Method:** Parse `backend/.dockerignore` + recursive file walk. Docker CLI not installed; `docker build --dry-run` not run.

**`.dockerignore` excludes:** `node_modules`, `.env` / `.env.*` except `.env.example`, `*.md`, `deploy-out*.txt`, `scripts/_tmp_*`, `scripts/tmp_*`, `scripts/_run_prod_*`, `scripts/_run_audit_*`, `scripts/_sftp_*`, `tmp-optiona-smoke-pine`, `tmp-*`, `tmp_*`, `**/__tests__`, `**/*.test.js`, `*.cmd`, `*.hex`, `dev-users.json`, coverage, `.git`.

| Check | Result |
|-------|--------|
| 1. What `.dockerignore` excludes | Listed above. Last-match wins; `.env.example` is re-included. |
| 2. Tests excluded? | **YES.** Simulated context contains **0** `__tests__` / `*.test.js`. |
| 3. `tmp-*` excluded? | **YES.** |
| 4. `deploy-out*` excluded? | **YES.** |
| 5. `_tmp_*` excluded? | **YES** (`scripts/_tmp_*` and `tmp_*`). |
| 6. Audit scripts excluded? | **YES** (`_run_audit_*`, `_run_prod_*`, `*.cmd`, `*.hex`). |
| 7. Required runtime files accidentally excluded? | **NO.** All 21 required paths are YES (see below). |
| 8. Required untracked production files WILL enter? | **YES:** `models/DeliveryJob.js`, `utils/durableDelivery.js`, `utils/deliverySequencer.js`, `utils/deliveryIdempotency.js`, `utils/tradeEventStore.js`, `utils/tradeEventDispatcher.js`, `utils/tradeEventIdentity.js`, `services/PineCompatibilityService.js`, `config/PineCompatibilityRegistry.js`, `contracts/KachingTradeEvent.js`. |

**Would-send count:** **206 files.**

**Risk-pattern files that would still enter (`tmp-`, `deploy-out`, `_tmp_`, `_run_audit`, `_run_prod`, `*.md`, `*.test.js`, `__tests__`, `*.cmd`, `*.hex`, `*.zip`):** **0.**

**Would still enter (inert at `CMD ["node", "server.js"]`):** 19 `scripts/*.js` ops helpers (including `clear-pipeline-status-redis.js`, `revoke-duplicate-mpesa.fly.js`, `smoke-pine-gen.js`), 7 `scripts/*.ps1`, `scripts/fly-secrets.example.env` (placeholders, not live secrets), `tradingview-alert-example.json`.

**Would also enter (runtime, unrelated to this delivery stack):** `config/subscriptions.js`, `routes/auth.js`, `services/ActivationService.js`, `utils/mailer.js`, updated `fly.toml`.

**Secrets:** `.env` / `.env.*` ignored. `fly-secrets.example.env` in the image has empty values only.

**Expected image runtime manifest (after `npm ci --omit=dev`):** Node 20 Alpine, production `node_modules`, plus the 206-file COPY set. Process starts `node server.js`. Recovery worker starts because Fly `[env] NODE_ENV=production` (not `test`).

Dirty working tree **does not** dump audit logs into production. That previous risk is closed by `.dockerignore`.

---

## 4. REQUIRED RELEASE FILES

These **must deploy together**. Partial deploy is **not** safe.

Import trace (production webhook → Telegram):

```
server.js
  require(models/DeliveryJob)                          // indexes register at boot
  POST /api/webhook/tradingview
    → TradingViewAlertService.acceptTradingViewWebhook
         PineCompatibilityService + PineCompatibilityRegistry + KachingTradeEvent
         tradeEventIdentity / tradeEventStore.claimEventId (never empty-allow)
         TradeEventDispatcher.withCanonicalLock
         TradeLifecycleService
         Signal persist
         DurableDelivery.ensureFanoutWork               // BEFORE HTTP 202
    → 202
    → scheduleAcceptedTradingViewSignal
         DurableDelivery.beginFanoutAttempt (Redis lease)
         TradeDeliveryService
            deliverySequencer.withChannelSequence       // ENTRY COMMITTED gate
            deliveryIdempotency.claimDelivery           // → DurableDelivery.beginAttempt
            markSending → Telegram sendMessage
            markProviderAccepted → commitDelivered
            onEntryCommitted unblocks outcomes
  listen callback
    DurableDelivery.startRecoveryWorker                 // skipped only when NODE_ENV=test
```

`PipelineStatusService` reads `DurableDelivery.getCounts()`. `LicenseTokenService` remains on the auth path (kls_v1/v2). Templates are the generator, not the ingest path for existing subscriber scripts.

**Exact minimum backend set for a complete delivery release:**

- `server.js`
- `Dockerfile`, `.dockerignore`, `fly.toml`, `package.json`, `package-lock.json`
- `models/DeliveryJob.js`, `models/Signal.js`
- `utils/durableDelivery.js`, `utils/deliverySequencer.js`, `utils/deliveryIdempotency.js`
- `utils/tradeEventStore.js`, `utils/tradeEventDispatcher.js`, `utils/tradeEventIdentity.js`
- `utils/PineClientVersion.js`, `utils/pipelineLog.js`
- `services/TradingViewAlertService.js`, `services/TradeDeliveryService.js`
- `services/TradeLifecycleService.js`, `services/PineCompatibilityService.js`
- `services/PipelineStatusService.js`, `services/LicenseTokenService.js`
- `services/SubscriberSignalFormatter.js`, `services/SignalOutcomeService.js`
- `config/PineCompatibilityRegistry.js`, `contracts/KachingTradeEvent.js`
- Pine templates/snippets (already 1.3.0; do not edit; existing subscribers keep current scripts)
- Existing runtime already in HEAD that these files call (`TelegramService.js`, `redisClient.js`, `models/User.js`, routes, strategies, etc.)

Deploying only sequencer without durable recovery restores lost-work after ENTRY send fail. Deploying durable without sequencer restores TP-before-ENTRY. Deploying `server.js` worker without `durableDelivery.js` crashes boot. Deploying compat without `tradeEventStore` empty-eventId throw restores the allow-bypass.

---

## 5. EXCLUDED / UNRELATED FILES

**Excluded from image (safe):** all `*_REPORT.md`, all tests, all `deploy-out*`, all `tmp-*`, all `_tmp_*` / `_run_audit_*` / `_run_prod_*`, `dev-users.json`, `.env`, frontend, `python-service/`, `tmp-mpesa-backend.zip`, `u.telegram`.

**Unrelated but WOULD enter the API image** if you `fly deploy` from `backend/`:

| File | Effect if shipped |
|------|-------------------|
| `config/subscriptions.js` | PayPal/Binance `priceCents` = KES/130 (Basic 5000 KES → $38.46, not the old $55.00) |
| `services/ActivationService.js` | Manual Binance amount must match plan USDT |
| `routes/auth.js` + `utils/mailer.js` | Quota-aware verification copy; bulk email circuit |
| `fly.toml` | Sets `EMAIL_TRADE_ALERTS_ENABLED=true`; removes explicit `SCANNER_AUTO_ENABLED=true` from `[env]` (code still defaults ON unless `false`) |

**Unrelated and NOT in this image:** `frontend/src/components/{Checkout,ManualMpesaCheckout,Pricing}.jsx`. Live Pages will not show the new USDT lines until a separate Pages deploy.

---

## 6. STARTUP SAFETY RESULT

Read from actual code. All nine checks pass for production runtime.

| # | Requirement | Evidence | Result |
|---|----------------|----------|--------|
| 1 | DeliveryJob indexes initialized safely | `server.js` eagerly `require('./models/DeliveryJob')`. Schema defines unique `jobId` plus `{state,nextAttemptAt}`, `{state,leaseUntil}`, identity index. No `autoIndex: false`. Mongoose creates indexes on connect. Missing collection/indexes do not throw boot. | PASS |
| 2 | Recovery workers start only outside tests | `server.js` listen: `NODE_ENV !== 'test'` then `startRecoveryWorker`. Worker itself also returns early in test unless `DELIVERY_RECOVERY_WORKER_IN_TEST=1`. Fly `NODE_ENV=production`. | PASS |
| 3 | Multiple Fly machines can run workers safely | Each machine runs `setInterval` + `unref`. Duplicate workers are expected. Ownership is Redis `SET NX` lease `kaching:trade:dlease:{jobId}` keyed by `FLY_MACHINE_ID` / `FLY_ALLOC_ID`. | PASS |
| 4 | Redis lease prevents two workers on same job | `setLease` uses `SET NX PX`. `beginAttempt` returns `busy` on live lease. Tests: two machines one winner. | PASS |
| 5 | Mongo is durable source of unfinished work | `listJobIdsFromMongo` queries PENDING / RETRY_PENDING / BLOCKED / PROVIDER_ACCEPTED / expired PROCESSING|SENDING. Redis job JSON is cache (7d TTL). Redis restart test reloads from durable docs. | PASS |
| 6 | Redis errors in background workers do not crash API | `processDueJobs` catches list/handler errors, sets `lastWorkerError`, logs, continues. `startRecoveryWorker` `.catch` on tick. Isolated test in hardening suite. | PASS |
| 7 | Redis failure during webhook ingestion = fail-closed 503 | `claimEventId` throws `REDIS_UNAVAILABLE`. `acceptTradingViewWebhook` maps to `httpStatus: 503`. `rejectedWebhookHttpStatus('redis_unavailable')` is 503. Hardening + kachingAlertOnce tests. | PASS |
| 8 | Mongo failure during required job creation fails safely | `persistDurable(..., {ingest:true})` throws `MONGO_UNAVAILABLE` when production Mongo is required. Accept does not return 202 without durable work. Uncaught `mongo` errors in `server.js` become **500** (regex `/mongo/`), which is fail-closed (TradingView retries 5xx). Duplicate retry recreates missing fan-out job (crash A). | PASS (500 not 503; still fail-closed) |
| 9 | API starts with no unfinished jobs | Worker `listDueJobs` returns `[]`. `/api/health` does not wait on jobs (crypto self-check only). Empty `delivery_jobs` is fine. | PASS |

`TradeEventDispatcher` remains process-local. Cross-machine authority is Redis sequencer + durable jobs + leases.

---

## 7. DELIVERY STATE MACHINE RESULT

Implemented states (Mongo enum + `DurableDelivery.STATES`):

`pending` → `processing` → `sending` → `provider_accepted` → `delivered`  
also: `retry_pending`, `blocked_waiting_for_entry`, `failed_terminal`

(`COMMITTED` is the log/event name for durable `delivered` after provider success + sequencer commit.)

| # | Spec item | Result |
|---|-----------|--------|
| 1 | Durable fan-out job exists before HTTP 202 (`PENDING`) | `ensureFanoutWork` awaited in `acceptAfterValidation` before return; `server.js` 202 after accept. |
| 2 | PROCESSING is an expiring Redis lease, not a completion flag | `beginAttempt` SET NX; `leaseUntil`; crash C reclaim. |
| 3 | SENDING recorded before provider HTTP | `markSendingBySpec` then `TelegramService.notifySubscriber`. |
| 4 | PROVIDER_ACCEPTED immediately after provider HTTP 200 | `markProviderAcceptedBySpec` then `commitDeliverySuccess`. |
| 5 | COMMITTED/DELIVERED only after provider success | `commitDelivered` after accepted; sequencer `markDeliveryCommitted` only if `result.ok`. |
| 6 | RETRY_PENDING + exponential backoff | `scheduleRetry`; fake-clock `not_due` until `nextAttemptAt`. |
| 7 | Outcomes BLOCKED_WAITING_FOR_ENTRY until ENTRY **delivery COMMITTED** | Sequencer waits on committed HASH; timeout writes blocked job; `onEntryCommitted` unblocks. Not webhook 202, not job-exists. |
| 8 | FAILED_TERMINAL after max attempts; no silent TP3 | Hardening: ENTRY terminal keeps TP3 blocked; `retryFailedTerminal` is explicit. |
| 9 | Duplicate webhook after COMMITTED does not resend | `claimEventId` miss → duplicate ack; `beginAttempt` status `delivered` → no send. Crash E. |
| 10 | Two machines: one lease winner; expiry reclaim | Hardening two-machine tests. |
| 11 | Unavoidable crash window is at-least-once | See below. Not rewritten. Telegram `sendMessage` has no idempotency key (`chat_id`+`text` only). |

**Unavoidable crash window (do not claim exactly-once):**

```
Telegram HTTP 200  →  crash  →  before PROVIDER_ACCEPTED persisted
= AT-LEAST-ONCE (possible duplicate subscriber message)
```

After `PROVIDER_ACCEPTED`, recovery finishes COMMITTED **without** a second provider send (`claimDelivery` status `provider_accepted`). App-layer post-COMMITTED duplicates are suppressed.

Telegram 200 means queued at Telegram, not phone display.

---

## 8. BACKWARD COMPATIBILITY RESULT

Pine templates/snippets were **not** modified in this audit. Webhook path and `{{alert_message}}` instructions unchanged. `WEBHOOK_TRADINGVIEW_URL` remains `${PUBLIC_BACKEND_URL}/api/webhook/tradingview` → production `https://api.kachingscanner.com/api/webhook/tradingview`.

| # | Spec item | Result |
|---|-----------|--------|
| 1 | Old Pine versions still work | Legacy + 1.2 adapters; e2e tests in `pineCompatibilityLayer.test.js`. |
| 2 | Current 1.3.0 unchanged for existing users | Stamp remains `1.3.0`. No regen required for this backend deploy. |
| 3 | New Pine stays 1.3.0 / inferred stable-v1 | Shared normalizer; `schemaVersion` inferred. |
| 4 | Backend upgrades without forcing Pine regen | Class A. Compatibility gateway. |
| 5 | One canonical event after ingest | `normalizeIncomingPineEvent` → `KachingTradeEvent`. |
| 6 | Duplicate suppression for all versions | Always `claimEventId` after derive/native id. |
| 7 | Missing/empty eventId no longer auto-allows | Derive or HTTP 409; `claimEventId('')` throws `missing_event_identity`. |
| 8 | Legacy realtime unknown uses freshness | `evaluateUnknownRealtimeFreshness`; not silent ancient allow. |
| 9 | Redis production authority / fail-closed | 503 `redis_unavailable`. |
| 10 | kls_v1 + kls_v2; outer CR only | `normalizeLicenseTokenTransport`; inner CR still HMAC-fails. |
| 11 | Fast-ack and webhook URL unchanged | HTTP 202 after persist+fan-out job; URL unchanged. |
| 12 | Not deployed until approval | Production still v139. This audit did not deploy. |

Old 1.2.x chart drawings still cannot be fixed remotely. That is pre-existing, not a new blocker.

---

## 9. TEST RESULTS

Re-run 2026-08-25 from `backend/`. No assertions weakened. No tests skipped to go green. **NEW TESTS ADDED: 0.** No production-blocker defect was found that required a new regression test.

| Run | TOTAL | PASS | FAIL | SKIPPED |
|-----|------:|-----:|-----:|--------:|
| `finalReleaseHardening.test.js` | 16 | 16 | 0 | 0 |
| `durableDeliveryRecovery.test.js` | 17 | 17 | 0 | 0 |
| Related suite (hardening + durable + entryFirst + pineCompatibility + kachingAlertOnce + distributedLifecycle + webhookFastAck + telegramTradeAlertDelivery) | **155** | **155** | 0 | 0 |
| `node scripts/smoke-pine-gen.js` (`NODE_ENV=test`) | — | **ok: true**, **violations 0** | — | — |
| Full `npm test` | **711** | **709** | **0** | **2** |

Related suite duration ~71s. Full `npm test`: 153 suites, ~144s.

**Skipped (pre-existing, Redis not available in this environment; MT5 pairing not weakened):**

- `stores and atomically consumes PairCode via Redis GETDEL when available`
- `concurrent Redis completePairing yields a single winner`

Known flake (`mt5Pairing.test.js` + `mt5ReliabilityHardening.test.js` sharing `dev-users.json`) **did not occur**.

Smoke webhook URLs are localhost because `NODE_ENV=test`. That does not change production `WEBHOOK_TRADINGVIEW_URL`.

---

## 10. REMAINING REAL RISKS

| Level | Risk | Supported by |
|-------|------|----------------|
| **HIGH (accepted)** | At-least-once window: Telegram 200 before `PROVIDER_ACCEPTED`. Duplicate Telegram possible. | `TelegramService.sendMessage` payload has no idempotency key; crash D test. |
| **MEDIUM (operational)** | Same API image co-ships unrelated pricing/mailer/auth/ActivationService/`fly.toml` env. Frontend Pages will not match new USDT cents until a separate deploy. | Git diff + Docker context listing. |
| **MEDIUM (known)** | `TradeEventDispatcher` is process-local. Cross-machine order depends on Redis sequencer + durable jobs (tested). | Code comments + tests. |
| **MEDIUM (known)** | Sequencer-timeout outcome jobs may lack full subscriber snapshot → worker `missing_channel_payload` retry until a path with payload runs. ENTRY-first still holds. | `deliverDurableJob` + prior durable report. |
| **LOW** | Ops scripts in image (`clear-pipeline-status-redis.js`, `revoke-duplicate-mpesa.fly.js`) are not executed at startup. | Docker listing. |
| **LOW** | Mongo ingest failure returns HTTP **500** not 503. Still fail-closed; TV retries. Duplicate path recreates missing fan-out job. | `server.js` catch vs `acceptTradingViewWebhook` Redis mapping. |
| **LOW** | Telegram 200 = queued, not phone display. | Bot API. |
| **LOW** | `fly.toml` `min_machines_running = 1` is pre-existing; keep **scale count 2** operationally. | `fly.toml` (unchanged on this point). |
| **LOW** | Parallel-test flake on `dev-users.json`. Unrelated. Did not fire. | Prior reports. |

No remaining **code blocker** for Mongo source of truth, empty eventId allow, ENTRY-first COMMITTED gate, Redis ingest 503, worker isolation, or failing tests.

---

## 11. GO / CONDITIONAL GO / NO-GO

**B. CONDITIONAL GO — SAFE FOR CONTROLLED DEPLOYMENT**

Exact checks required **before** / **as part of** deployment (not theoretical):

1. **Accept co-ship:** This image will include unrelated local runtime diffs (`subscriptions.js` USD cents, `ActivationService` Binance amount lock, `mailer.js`/`auth.js` quota handling, `fly.toml` `EMAIL_TRADE_ALERTS_ENABLED=true`). If those must not ship, do not deploy this working tree (this audit will not revert them).
2. **Frontend window:** If live checkout USDT must match new `priceCents`, deploy Pages (`Checkout.jsx`, `ManualMpesaCheckout.jsx`, `Pricing.jsx`) in the same release window. API-only deploy changes PayPal/Binance amounts via API while old Pages UI may still show previous cents.
3. **Keep two machines:** After deploy, `fly scale count 2 --app kaching-api` (or confirm both machines already running). Do not rely on `min_machines_running = 1`.
4. **Do not** change webhook URL, `{{alert_message}}`, `WEBHOOK_SIGNING_SECRET`, Telegram token, or require Pine regen.
5. **Run live verification 1–13** immediately after both machines report the new version. Do not declare success on `/api/health` alone.

Docker build manifest for tmp/tests/audit/secrets: **safe**. Dirty tree alone is **not** a NO-GO.

---

## 12. EXACT DEPLOYMENT COMMANDS — BUT DO NOT RUN THEM

Do not run until the operator explicitly approves section 11.

```powershell
# 0) Confirm you are deploying backend only, from the backend directory.
cd "C:\Users\BM 03\Desktop\AIScanner\backend"

# 1) Confirm current production is still v139 (expect version 139).
fly status --app kaching-api
fly releases --app kaching-api

# 2) Confirm scale is two machines (or scale after deploy).
fly machines list --app kaching-api
# fly scale count 2 --app kaching-api

# 3) Do NOT set or rotate secrets. Do NOT change webhook URL.
# Optional env already has code defaults; override only if needed:
#   DELIVERY_MAX_ATTEMPTS=8
#   DELIVERY_RETRY_BASE_DELAY_MS=500
#   DELIVERY_RETRY_MAX_DELAY_MS=60000
#   DELIVERY_PROCESSING_LEASE_MS=120000
#   DELIVERY_RECOVERY_INTERVAL_MS=2000
#   DELIVERY_SEQ_WAIT_MS=120000

# 4) Deploy this backend working tree (Dockerfile COPY respects .dockerignore).
fly deploy --app kaching-api

# 5) Confirm both machines moved off v139 to the new release.
fly status --app kaching-api
fly machines list --app kaching-api
fly releases --app kaching-api

# 6) If checkout USDT UI must match, separately deploy frontend Pages
#    (not this Fly app). Do not mix that into the API image.
```

Webhook remains `https://api.kachingscanner.com/api/webhook/tradingview`. Message remains `{{alert_message}}`.

---

## 13. EXACT LIVE VERIFICATION COMMANDS

Run only after the new release is on **both** machines. Replace timestamps/symbols with a real controlled TradingView (or inject) event. Do not rotate secrets.

### 1. Health

```powershell
curl.exe -sS https://api.kachingscanner.com/api/health
# expect: HTTP 200, "status":"ok"
```

### 2. Both machines same version

```powershell
fly status --app kaching-api
fly machines list --app kaching-api
fly releases --app kaching-api
# both machines: same image / same release, not v139
```

### 3. Mongo indexes (`delivery_jobs`)

```powershell
fly ssh console --app kaching-api
```

Inside the machine:

```javascript
node -e "const m=require('mongoose'); m.connect(process.env.MONGODB_URI).then(async()=>{ const d=await m.connection.db.collection('delivery_jobs').indexes(); console.log(JSON.stringify(d,null,2)); process.exit(0); }).catch(e=>{ console.error(e); process.exit(1); });"
```

Expect unique `jobId` and indexes on `{state,nextAttemptAt}`, `{state,leaseUntil}`, identity.

### 4. Redis still required (fail-closed remains)

```powershell
fly logs --app kaching-api
# look for TradeEventStore / redis_unavailable only during a real Redis fault
# healthy: no ingest 503 under normal Redis
```

### 5. ENTRY webhook

Fire one live/legacy ENTRY to `https://api.kachingscanner.com/api/webhook/tradingview` with Message `{{alert_message}}`.

Expect: HTTP **202**, Mongo `delivery_jobs` fan-out + telegram jobs, Telegram ENTRY arrives, jobs `delivered`.

```powershell
fly logs --app kaching-api
# DELIVERY_JOB_CREATED, LEASE_ACQUIRED, PROVIDER_SEND_STARTED, PROVIDER_ACCEPTED, COMMITTED
```

### 6. Duplicate same ENTRY

Resend the identical payload.

Expect: HTTP **202** `duplicate: true` (or equivalent duplicate ack), **no** second Telegram.

### 7. ENTRY then TP1

Expect Telegram order **ENTRY then TP1**. Never TP1 first.

### 8. ENTRY then TP3 skip-milestone

TP1/TP2 never accepted. Expect ENTRY then TP3 / TRADE COMPLETE. No synthetic TP1/TP2.

### 9. ENTRY fail blocks TP3 then retry

Force ENTRY send fail (or observe a real provider fail). Expect TP3 `blocked_waiting_for_entry` / not delivered. After ENTRY retry success: ENTRY then TP3.

### 10. Legacy payload (no `pineClientVersion`)

Expect HTTP 202 (or documented freshness skip), derived identity, no empty-eventId allow.

### 11. Pine 1.3.0 payload

Expect native path 202 + delivery. No subscriber regen.

### 12. Redis outage 503

If Redis is taken down (controlled): webhook returns **503** `redis_unavailable`. No process-local claim. Restore Redis.

### 13. One machine restart reclaim

Stop one Fly machine mid-send (or restart it). Other machine reclaims expired PROCESSING/SENDING lease. Job is not permanently lost. Expect `RECOVERED` / `LEASE_ACQUIRED` on the survivor.

Also confirm PipelineStatus counts include `pending`, `processing`, `sending`, `retry_pending`, `provider_accepted`, `delivered`, `failed_terminal`, `blocked_waiting_for_entry`.

---

## 14. EXACT ROLLBACK COMMANDS

Rollback target: Fly `kaching-api` **v139**. No Pine change. No subscriber action. No webhook URL or secret change.

```powershell
cd "C:\Users\BM 03\Desktop\AIScanner\backend"

# Confirm current and v139 image/version
fly releases --app kaching-api
fly status --app kaching-api

# Roll back to v139 (Fly previous release). If more than one release was shipped,
# pass the v139 release id explicitly, e.g.:
#   fly releases rollback v139 --app kaching-api
fly releases rollback --app kaching-api

# Confirm both machines are v139 again
fly status --app kaching-api
fly machines list --app kaching-api
fly releases --app kaching-api

curl.exe -sS https://api.kachingscanner.com/api/health
```

**DeliveryJob data:** v139 does **not** read `delivery_jobs`. Documents created by the new image remain in Mongo and are **inert**. Do not drop the collection unless ops separately wants cleanup.

**Redis:** keys `kaching:trade:djob:*`, `kaching:trade:dlease:*`, `kaching:trade:djobidx` expire via TTL. v139 does not require them.

**Do not** rotate `WEBHOOK_SIGNING_SECRET`, `TRADINGVIEW_WEBHOOK_SECRET`, or Telegram bot token as part of rollback.

**Do not** ask subscribers to regenerate Pine or recreate alerts.

---

**STOP. Not deployed. Not committed. Not pushed. Pine not changed. Working tree not deleted or reset.**
