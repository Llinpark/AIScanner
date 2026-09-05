# CONTROLLED PRODUCTION DEPLOYMENT REPORT

**Date:** 2026-08-25  
**App:** Fly `kaching-api`  
**API:** https://api.kachingscanner.com  
**Webhook (unchanged):** https://api.kachingscanner.com/api/webhook/tradingview  
**Alert message (unchanged):** exactly `{{alert_message}}`  
**Telegram semantics:** **AT-LEAST-ONCE** (not exactly-once). Crash after Telegram HTTP 200 and before durable `PROVIDER_ACCEPTED` can duplicate one message.

This deploy did **not** rotate secrets, change the webhook URL, regenerate subscriber Pine, or deploy the frontend. The local working tree was not reset, stashed, committed, or pushed.

---

## 1. Previous production version

**v139**  
Image: `kaching-api:deployment-01M0WBKPMK40KD5HJT88A7FW7D`  
Two machines, both started, health checks passing.

## 2. New deployed version

**v140** (complete)

## 3. Fly release ID / image

- Release: **v140** complete  
- Image: `registry.fly.io/kaching-api:deployment-01M0WSH1FPN7F6KE9YV8V1Z6HX`  
- Manifest: `sha256:3cdc60497c000844ea287f4d12c092acea35d8438d1bac8aa20b3e7699811ba6`  
- Remote Depot build (local Docker CLI not installed)

## 4. Machine count and machine IDs

**2 machines** (unchanged; not scaled down)

| ID | Name | Version | State | Checks | Image |
|----|------|---------|-------|--------|-------|
| `d8d452ea420dd8` | crimson-wind-1485 | 140 | started | 1/1 | `deployment-01M0WSH1FPN7F6KE9YV8V1Z6HX` |
| `1857633da77168` | proud-silence-8240 | 140 | started | 1/1 | `deployment-01M0WSH1FPN7F6KE9YV8V1Z6HX` |

Region: `ams`. Size: shared-cpu-1x 512MB.

## 5. Health check result

`GET https://api.kachingscanner.com/api/health` → **HTTP 200**  
Body: `{"status":"ok","service":"backend","licenseTokenCrypto":"ok"}`  
Both machines listen on `0.0.0.0:8080`. Mongo connected. Redis ready (`Mt5Pairing` Redis ready). No crash loop.

## 6. Test suite result

From `backend/` with assertions **not** weakened:

| Run | Total | Pass | Fail | Skipped |
|-----|------:|-----:|-----:|--------:|
| `npm test` | 711 | 709 | **0** | **2** |
| Targeted 8 suites | 155 | 155 | **0** | **0** |

Skipped (pre-existing, Redis unavailable locally; MT5 pairing not weakened):

- `stores and atomically consumes PairCode via Redis GETDEL when available`
- `concurrent Redis completePairing yields a single winner`

Known `dev-users.json` parallel flake did **not** occur.

## 7. Pine smoke test result

`node scripts/smoke-pine-gen.js` (`NODE_ENV=test`): **`ok: true`**, **`violations: 0`**  
Smoke webhook URLs are localhost because `NODE_ENV=test`. Production webhook remains `https://api.kachingscanner.com/api/webhook/tradingview`.

## 8. ENTRY delivery result

**VERIFIED** (live production traffic after v140).

Observed on `JUMP_100_INDEX` 3m scalping (clean identity, not the CR-corrupted twin):

- Telegram `PROVIDER_SEND_STARTED` → `TELEGRAM SEND SUCCESS` → `PROVIDER_ACCEPTED` → `COMMITTED` (`state=delivered`)
- Durable job id present; lease then cleared on commit

Did **not** inject a fake trade to all subscribers.

## 9. Duplicate suppression result

**NOT VERIFIED** live (no identical re-POST observed in the log window after COMMITTED).

Covered by local hardening tests (crash E / duplicate webhook after COMMITTED does not resend). Honest production claim remains **at-least-once** at the Telegram boundary.

## 10. ENTRY-first sequencing result

**VERIFIED** live.

TP1 jobs logged `delivery_sequence_wait; predecessor=entry; eventType=take_profit_1` on email **while** Telegram ENTRY was still sending / before ENTRY COMMITTED. TP1 was not delivered first. Both Fly machines participated in sequencing (Redis sequencer + durable jobs).

## 11. Legacy compatibility result

**PARTIAL / VERIFIED ingest, mixed auth.**

Live `pineClientVersion=1.2.1` payloads hit `POST /api/webhook/tradingview` and parsed (`parseNote=ok`). Some 1.2.1 bodies had embedded CR (`sho\rt` / `ent\ry`) and failed **auth** (`invalid_license_token`, `hasCR=true`, `hmacMatch=none`) **before** delivery — expected for inner-CR HMAC (outer-CR trim only; inner CR still fails). A later clean 1.2.1-family identity (`…-short`) accepted and delivered. No empty-eventId allow observed. **No subscriber Pine regeneration.**

## 12. Pine 1.3.0 compatibility result

**NOT VERIFIED** live (no `pineClientVersion=1.3.0` payload in the post-deploy log window).  
**VERIFIED** by local `pineCompatibilityLayer.test.js` + smoke generator stamp `1.3.0` / `stable-v1`. Existing 1.3.0 subscribers were not asked to regenerate.

## 13. Recovery / lease result

**PARTIAL VERIFIED.**

- **VERIFIED:** Mongo `delivery_jobs` indexes exist: unique `jobId`, `{state,nextAttemptAt}`, `{state,leaseUntil}`, `idx_delivery_identity`.
- **VERIFIED:** Live `LEASE_ACQUIRED`, `PROVIDER_ACCEPTED`, `COMMITTED`.
- **VERIFIED (TEST 11):** Controlled restart of **one** machine (`1857633da77168`). API health stayed **HTTP 200** on the survivor; both machines returned to v140 started / 1/1.
- **NOT VERIFIED:** Mid-send crash reclaim of a `SENDING` job onto the other machine (would require interrupting an in-flight Telegram send).
- Recovery worker starts in production (`NODE_ENV !== test`); it does not log a banner on boot. No `[DurableDelivery] Failed to start recovery worker` and no recovery-tick crash of the API process.

## 14. Any warnings

1. **Co-shipped unrelated runtime** (accepted CONDITIONAL GO): `config/subscriptions.js` (KES→USD `priceCents`), `ActivationService.js` (Binance amount lock), `routes/auth.js` + `utils/mailer.js` (quota circuit), `fly.toml` `EMAIL_TRADE_ALERTS_ENABLED=true`. Frontend Checkout/Pricing Pages **not** deployed — live USDT UI may not match new API cents until a Pages deploy.
2. **Working-tree Pine templates/snippets were already dirty vs HEAD** (1.3.0 stacked work). This deploy did **not** further edit them and did **not** regen subscribers. Generator still instructs Message exactly `{{alert_message}}`.
3. **At-least-once Telegram:** no Bot API idempotency key. Do not claim exactly-once.
4. **Sequence-wait log volume:** many `delivery_sequence_wait` lines on email TP1 while ENTRY committed on Telegram. Expected, noisy, not a crash.
5. **Rolling deploy:** first machine briefly not listening on 8080 during boot (Fly warning); health then passed. Same pattern on the second machine (~5s). Pre-existing boot vs health-check race.
6. **Some 1.2.1 webhooks fail HMAC** because the Pine JSON contains CR/spaces inside the license token. Fail-closed auth (not 500). Pre-existing jsonEsc class of payload; not treated as a v140 webhook-500 spike.
7. **TEST 7 (ENTRY fail block)** skipped — not production-safe to leave subscribers blocked.
8. **TEST 12 (Redis outage 503)** skipped — would disrupt production Redis. Fail-closed 503 remains covered by tests and `claimEventId` throw `REDIS_UNAVAILABLE`.
9. Fly CLI on this Windows host is `flyctl.exe` (not `fly` on PATH). Auth used existing Fly login after CLI re-auth. Secrets were not rotated.
10. `printenv` name dump was not run (credential-adjacent). Production `NODE_ENV=production`, `PORT=8080`, `HOST=0.0.0.0` confirmed from boot logs.

## 15. Whether rollback was required

**No.** Health 200, both machines v140, no crash loop, webhook path live, ENTRY Telegram committed, ENTRY-first wait observed, Mongo indexes present.

Rollback target remains **v139** if needed later: `fly releases rollback --app kaching-api` (or explicit v139). `delivery_jobs` documents would stay inert on v139 — do not drop the collection as part of rollback.

## 16. FINAL VERDICT

**DEPLOYMENT SUCCESSFUL**

Stacked release 1–15 is on both machines as **v140**. Telegram remains **AT-LEAST-ONCE**. Webhook URL and `{{alert_message}}` unchanged. No Pine regen. No secret rotation. No frontend deploy. Two machines kept.

---

### Live verification 1–13 (honest)

| # | Check | Result |
|---|--------|--------|
| 1 | Health | **VERIFIED** HTTP 200 |
| 2 | Both machines same new version | **VERIFIED** v140, same image |
| 3 | Mongo `delivery_jobs` indexes | **VERIFIED** unique `jobId` + state/lease/identity |
| 4 | Redis fail-closed remains | **NOT VERIFIED** live outage (skipped for safety); code/tests + Redis ready at boot |
| 5 | ENTRY webhook → Telegram | **VERIFIED** SEND SUCCESS + PROVIDER_ACCEPTED + COMMITTED |
| 6 | Duplicate ENTRY | **NOT VERIFIED** live |
| 7 | ENTRY then TP1 order | **VERIFIED** TP1 `delivery_sequence_wait` predecessor=entry |
| 8 | ENTRY then TP3 skip-milestone | **NOT VERIFIED** live |
| 9 | ENTRY fail blocks TP3 | **NOT VERIFIED** (skipped for safety) |
| 10 | Legacy / 1.2 payload | **PARTIAL** parsed; CR-corrupt auth fail; clean identity delivered |
| 11 | Pine 1.3.0 payload | **NOT VERIFIED** live; tests + smoke pass |
| 12 | Redis 503 | **NOT VERIFIED** (skipped for safety) |
| 13 | One machine restart | **VERIFIED** API stayed up; both healthy on v140 |

### Required runtime files in the image

Confirmed present on the machine: `DeliveryJob.js`, `durableDelivery.js`, `deliverySequencer.js`, `deliveryIdempotency.js`, `tradeEventStore.js`, `PineCompatibilityService.js`, `PineCompatibilityRegistry.js`, `KachingTradeEvent.js`.
