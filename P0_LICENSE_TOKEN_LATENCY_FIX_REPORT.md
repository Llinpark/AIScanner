# P0 License Token + Latency Fix — Deployment-Readiness Report

**Isolated tree:** `C:\TEMP\kaching-v154-license-latency-fix`  
**Source compared against:** `C:\TEMP\kaching-v146-correlation-repair` (production-equivalent kaching-api v154)  
**Date:** 2026-09-02  
**Deploy:** **NOT performed.** No `fly deploy`, no machine restart, no production Redis/Mongo changes.

---

## 1. Exact root cause of `invalid_license_token`

Path: HTTP `POST /api/webhook/tradingview` → `assertTradingViewWebhook` → `verifyTradingViewWebhook` (`utils/webhookSecurity.js`) → JSON body field **`licenseToken`** (alias `license_token`; not a header, not query) → `verifyLicenseTokenDetailed` (`services/LicenseTokenService.js`).

Reject is produced here when HMAC of the middle payload segment does not match `WEBHOOK_SIGNING_SECRET`:

```
if (!timingSafeEqualString(signature, expected)) {
  return failVerify('invalid_license_token', info);
}
```

Production evidence (`requestId=tvw_mtjxh4lj_111309c0`):

- Token **present**, `prefix=kls_v1`, `parts=3`, `decodeOk=true`, `payloadVersion=2`
- `hmacMatch=none` — signature matches **none** of `WEBHOOK_SIGNING_SECRET` / `TRADINGVIEW_WEBHOOK_SECRET` / `JWT_SECRET`
- `hasCR=true`, `hasLF=false`, `hasSpace=true`

`hasSpace=true` was a **diagnostic false positive**: the old check was `/\s/` which also matches CR. A CR-only token therefore logged both `hasCR` and `hasSpace`.

If CR/space sit only at the **ends** of the token (TradingView HTTP body / Windows CRLF on the JSON string value), they are included in the signature string unless stripped. This tree already had outer trim; HMAC is computed **after** that trim. Production `length=161` is the **normalized** length. Therefore:

- Boundary CR/LF/space **can** cause `invalid_license_token` on code that does **not** trim (older Pine/TV payloads).
- On v154, if outer trim was already live, `hmacMatch=none` with `length=161` is **not** explained by trailing CR alone. Remaining explanations: (a) CR/space **inside** a part (now flagged as `containedInnerCR`), or (b) **kls_v1 minted with a different signing secret** than the current `WEBHOOK_SIGNING_SECRET` (rotation / env mismatch). After this fix, LICENSE DIAG distinguishes those cases without logging the token.

Auth invariants unchanged:

- missing token → 401  
- empty after normalization → 401 (`licenseToken_absent`)  
- wrong/tampered token → 401 (`invalid_license_token`)  
- valid token with accidental leading/trailing CR/LF/space → **accepted**

---

## 2. Exact source of CR / LF / whitespace

| Layer | Finding |
|---|---|
| **A. Pine generation** | Template was `LICENSE_TOKEN = "{{LICENSE_TOKEN}}"`. Generated files on Windows use CRLF **outside** the quotes, which Pine normally does not put inside the string. Generator `escapePineString` does not add CR. **Risk:** copy/paste or TV source upload can still leave CR on the constant. **Fixed for new scripts:** `LICENSE_TOKEN = str.trim("{{LICENSE_TOKEN}}")` and `jsonEsc(str.trim(LICENSE_TOKEN))` in `buildPayload`. |
| **B. TradingView alert config** | Alert Message must be exactly `{{alert_message}}`. Manual JSON in the Message field can add trailing CR/space inside the `licenseToken` string. Existing subscribers are **not** required to regenerate; backend trim covers that. |
| **C. Webhook JSON payload** | Field is `"licenseToken":"<token>"`. JSON.parse keeps CR if it is inside the quoted string. HTTP framing CRLF after the JSON object does **not** enter the field. |
| **D. Backend parsing** | `parseWebhookBody` trims the **whole body**. It does not trim individual string values. Token cleanup is in `normalizeLicenseTokenTransport`. |
| **E. Diagnostic** | `hasSpace: /\s/` treated CR as a space. Fixed: `hasSpace` is `[ \t\u00a0]` only. |

**Conclusion:** CR is a **transport/TV/Windows** artifact on the token **string value**, not HMAC payload contents. Pine generator now emits a trimmed token so **future** scripts are clean. Backend still accepts old alerts with boundary whitespace.

---

## 3. Files changed and why

Runtime (isolated tree):

| File | Why |
|---|---|
| `services/LicenseTokenService.js` | Outer + per-part trim of CR/LF/space/BOM; diagnostics: `tokenPresent`, `originalLength`, `normalizedLength`, `hadLeadingWhitespace`, `hadTrailingWhitespace`, `containedCR`, `containedLF`, `containedInnerCR/LF`; `hasSpace` no longer matches CR |
| `utils/webhookSecurity.js` | Enter license path when token is present (including whitespace-only); still 401 after empty normalize |
| `server.js` | LICENSE DIAG fields; stamp `webhookReceivedAt` / `authCompletedAt` / `durableAcceptCompletedAt` / `httpAckAt`; one `[TV_LATENCY]` line on accepted ACK |
| `utils/tvLatencyTrace.js` | **New.** Correlation + timestamps + buckets; no secrets |
| `services/TradingViewAlertService.js` | `eventTimestamp` from identity time; lifecycle/persist/background/fanout stamps; pass `timings` into fan-out; `[TV_LATENCY_PIPELINE]` after fan-out |
| `services/TradeDeliveryService.js` | First telegram/email/mt5 start/complete stamps on shared `timings` |
| `utils/tradeEventIdentity.js` | **Protected file (justified).** `parseEventTimestamp` prefers `signalTime` / UUID-embedded time over `barTime`/`timestamp` so delayed emission cannot refresh an old ENTRY |
| `templates/kaching-sweep-fvg-scalp.pine.template` | `str.trim` on LICENSE_TOKEN; `signalTime` + `alertFiredAt` in payload |
| `templates/kaching-sweep-fvg-daytrading.pine.template` | Same |
| `templates/snippets/kaching-canon-event-arm.pine.snippet` | Pass original `stEv` / `tradeEntrySignalTime()` into `buildPayload` |

Tests:

- `utils/__tests__/licenseTokenNormalization.test.js` (and `services/__tests__/licenseTokenNormalization.test.js`)
- `utils/__tests__/tvLatencyTrace.test.js`
- `utils/__tests__/staleEntrySixBars.test.js`
- assertion updates: `pineLicenseLifecycle.test.js`, `kachingDrawingLifecycle.test.js`, `licenseTokenService.test.js`

**Not changed:** Dockerfile, fly.toml, package.json, recovery-worker env, Redis/Mongo, mailer, durableDelivery, outcome-lock modules (except identity timestamp order).

---

## 4. Runtime diff count versus current production-equivalent source

Counted by SHA-256 of files in the isolated tree vs `C:\TEMP\kaching-v146-correlation-repair` (excluding `node_modules`, `.git`, `dist`, logs).

- **Changed runtime/source files:** 10 (server, LicenseTokenService, webhookSecurity, tradeEventIdentity, TradingViewAlertService, TradeDeliveryService, 2 templates, 1 snippet)
- **Changed test files:** 3
- **Added files:** 5 (tvLatencyTrace + 4 test files; hashes files are report artifacts)
- **`dev-users.json`:** mutated during tests; **restored** from the original tree before this report
- **Dockerfile / fly.toml / package.json:** unchanged

---

## 5. SHA-256 verification of protected files (before vs after)

Taken from isolated-tree copies of the v154 source **before edits**, then re-hashed after.

| File | Before | After | Status |
|---|---|---|---|
| `utils/signalOutcome.js` | `5188F51F3B665939CB11F721F7E51E7F712C446DCAF54FB1049727031747184C` | same | **UNCHANGED** |
| `services/SignalOutcomeService.js` | `2BFAB48C485BB220E96EA4E0C11D1760DBC11ECB447406C8DFB181E39BC3ECD4` | same | **UNCHANGED** |
| `services/TradeLifecycleService.js` | `3D868C1EED6D31EEBFBBCA3DCE13B56B8F78D4EF8F0D2B867181F16983642F52` | same | **UNCHANGED** |
| `utils/tradeEventIdentity.js` | `312469C22D467ECE33B09453FA551D096171E8E90E9555FD8B3F5969B3D965B4` | `CFFEACD3A9EB7C46BD91B3CBFF7122FEDD7CF5D4EBE99C7F3FDD4E748F2538A3` | **CHANGED (justified)** |
| `utils/mailer.js` | `B3F6E66AC11973500C7B24D62039A135D3CC0B3470521D0890A936BED0D5C575` | same | **UNCHANGED** |
| `utils/deliveryIdempotency.js` | `F5129124604531B2BC90D696148BD5D8C1997F9B1E2D95797C294A1B64DB666F` | same | **UNCHANGED** |
| `services/PipelineStatusService.js` | `A269656B16998645E272506572E9CA2CBAE6F30344B79751D87879CC31694D0A` | same | **UNCHANGED** |
| `utils/durableDelivery.js` | `F3ABA00125C8D51E420A048E17F3364474B8691A3E2F3ABB2167EC42B11F9FE7` | same | **UNCHANGED** |

**Why `tradeEventIdentity.js`:** existing Pine payloads always send `barTime` (chart time at `alert()`). `parseEventTimestamp` used `barTime`/`timestamp` **before** the canonical UUID, so a delayed webhook looked fresh. Identity fields (`signalTime`, UUID `-c{tf}-{epoch}-`) now win. Diff is confined to `parseEventTimestamp`. Stale threshold (`MAX_ENTRY_SIGNAL_AGE_MS` = 30 minutes, floor 3 bars) was **not** changed. There is no `maxEntryAgeBars = 4` in this codebase (Pine FVG window is 10 bars; backend is time-based).

---

## 6. Authentication test results

`utils/__tests__/licenseTokenNormalization.test.js` + `services/__tests__/licenseTokenService.test.js` + `utils/__tests__/webhookSecurity.test.js` + `pineLicenseLifecycle.test.js`:

| # | Case | Result |
|---|---|---|
| 1 | Valid token | accepted |
| 2 | Leading space | accepted |
| 3 | Trailing space | accepted |
| 4 | Trailing `\r` | accepted |
| 5 | Trailing `\n` | accepted |
| 6 | Missing token | rejected (401-class) |
| 7 | Whitespace-only | rejected (`licenseToken_absent`) |
| 8 | Wrong/tampered token | rejected (`invalid_license_token`) |
| 9 | Normalization does not bypass HMAC (inner CR / padded garbage) | rejected |

`hasSpace` is no longer true for CR-only tokens. Tokens/secrets are not logged.

---

## 7. Latency instrumentation test results

`utils/__tests__/tvLatencyTrace.test.js` — all passed:

| # | Case | Result |
|---|---|---|
| 10 | Signal timestamp preserved from `signalTime` | pass |
| 11 | Receipt time distinct from detection | pass |
| 12 | Signal age = `webhook_received_at - signal_detected_at` | pass |
| 13 | Backend ACK = `http_ack_at - webhook_received_at` | pass |
| 14 | Delayed timestamps stay delayed (UUID wins over `barTime`) | pass |
| 15 | `requestId` / `eventId` survive later stamps | pass |

`webhook_sent_at` is recorded **only** if the payload has `webhookSentAt` / `webhook_sent_at` (Pine does not invent HTTP send time). Optional `alertFiredAt` (`timenow` at `alert()`) is separate.

One `[TV_LATENCY]` line per accepted ACK; one `[TV_LATENCY_PIPELINE]` per event after fan-out. Self-tests suppressed. No emails, chat IDs, or tokens in the line.

---

## 8. Stale-entry test results

`utils/__tests__/staleEntrySixBars.test.js` — all passed:

| # | Case | Result |
|---|---|---|
| 16 | ENTRY six 5m candles after true entry (`30min + 1ms` vs 30min cap, `ageMs > maxAgeMs`) | `stale_entry`, no Signal |
| 17 | No Telegram fan-out | pass |
| 18 | No email fan-out | pass |
| 19 | No MT5 fan-out | pass |
| 20 | Delayed TP1 on already-accepted trade is not a new ENTRY | pass |

Fresh `barTime` / webhook arrival cannot revive an old canonical UUID. Threshold not changed.

---

## 9. Full `npm test` results

Command (isolated tree):  
`node --test strategies/__tests__/**/*.test.js utils/__tests__/**/*.test.js middleware/__tests__/**/*.test.js services/__tests__/**/*.test.js`  
(same glob as `npm test`)

```
tests 903
suites 185
pass 901
fail 0
cancelled 0
skipped 2
duration_ms ~204913
```

**Skipped (2):** `services/__tests__/mt5Pairing.test.js` Redis integration cases — `t.skip('Redis not available in this environment')`. Not failures.

**Known flake (did not fire this run):** `mt5Pairing` / `mt5ReliabilityHardening` can contend on `dev-users.json` under parallel runs. This full run had **0 fails**. `dev-users.json` was restored after tests.

Critical suites included in the 901: highestTpOutcomeLock, terminalOutcomeLock, signalOrderingStale, signalPersistence, distributedLifecycleFix, entryFirstDeliverySequencing, webhookFastAck, durableDeliveryRecovery, mailerQuota, pine license/idempotency, delivery sequencing.

---

## 10. Sample structured trace (expected timestamps)

Accepted live ENTRY, `requestId` reused through async fan-out:

```
[TV_LATENCY] requestId=tvw_mtjxh4lj_111309c0 eventId=VOLATILITY_90_1S_INDEX|5|VOLATILITY_90_1S_INDEX-daytrading-c5-1756800000000-long|ENTRY signalUuid=VOLATILITY_90_1S_INDEX-daytrading-c5-1756800000000-long canonicalTradeId=VOLATILITY_90_1S_INDEX-daytrading-c5-1756800000000-long symbol=VOLATILITY_90_1S_INDEX alertType=entry signal_detected_at=2026-09-02T09:00:00.000Z webhook_sent_at=- webhook_received_at=2026-09-02T09:00:08.120Z auth_completed_at=2026-09-02T09:00:08.145Z durable_accept_completed_at=2026-09-02T09:00:08.210Z http_ack_at=2026-09-02T09:00:08.220Z background_processing_started_at=- signal_persisted_at=2026-09-02T09:00:08.205Z lifecycle_completed_at=2026-09-02T09:00:08.190Z fanout_enqueued_at=- telegram_dispatch_started_at=- telegram_dispatch_completed_at=- email_dispatch_started_at=- email_dispatch_completed_at=- socket_emitted_at=- mt5_dispatch_started_at=- mt5_dispatch_completed_at=- signalAgeAtWebhookReceiptMs=8120 backendAckLatencyMs=100 postAckProcessingMs=- fanoutLatencyMs=- telegramLatencyMs=- emailLatencyMs=- totalTimeToDeliveryMs=-
```

Later, same IDs:

```
[TV_LATENCY_PIPELINE] requestId=tvw_mtjxh4lj_111309c0 eventId=…|ENTRY … fanout_enqueued_at=2026-09-02T09:00:08.230Z background_processing_started_at=2026-09-02T09:00:08.235Z telegram_dispatch_started_at=2026-09-02T09:00:08.240Z telegram_dispatch_completed_at=2026-09-02T09:00:08.410Z email_dispatch_started_at=2026-09-02T09:00:08.240Z email_dispatch_completed_at=2026-09-02T09:00:08.390Z socket_emitted_at=2026-09-02T09:00:08.238Z … signalAgeAtWebhookReceiptMs=8120 backendAckLatencyMs=100 postAckProcessingMs=-15 fanoutLatencyMs=25 telegramLatencyMs=180 emailLatencyMs=160 totalTimeToDeliveryMs=8410
```

`-` means the timestamp was not present (never invented). `webhook_sent_at=-` unless the payload includes it.

---

## 11. How to tell, from one live event, who was late

Use **one** `requestId` / `eventId`. Compare:

| Question | Compare |
|---|---|
| **Pine late** (setup old before `alert()`) | Large `signalAgeAtWebhookReceiptMs` **and** `alertFiredAt` (if present) close to `signal_detected_at`? Pine delayed emit. If `alertFiredAt` is near `webhook_received_at` but `signal_detected_at` is much earlier, Pine held the event (or `barTime` was emission — now identity time wins). |
| **TradingView / network late** | `alertFiredAt` (Pine `timenow`) ≪ `webhook_received_at`, and `webhook_sent_at` missing or far from receipt. TV queue or HTTP delay. |
| **Backend ACK slow** | `backendAckLatencyMs` = `http_ack_at - webhook_received_at` (auth + durable accept). Target ≪ 1500ms (`TV_ACK_SLOW` already exists). |
| **Background processing slow** | `background_processing_started_at` vs `http_ack_at`; `signal_persisted_at` / `lifecycle_completed_at`. |
| **Fan-out slow** | `fanoutLatencyMs` = `fanout_enqueued_at - signal_persisted_at`. |
| **Telegram slow** | `telegramLatencyMs` = telegram completed − `fanout_enqueued_at`. |
| **Email slow** | `emailLatencyMs` similarly. |
| **Total to subscriber** | `totalTimeToDeliveryMs` = channel completed − `signal_detected_at`. |

Do **not** use HTTP receipt as signal time. LICENSE DIAG on 401s: if `containedInnerCR=true`, token still dirty inside; if `containedInnerCR=false` and `hmacMatch=none`, treat as **signing-secret mismatch** (not whitespace).

---

## 12. Confirmation: no deployment was performed

- No `fly deploy` / `flyctl deploy`
- No Fly machine restarts
- No production Redis or Mongo writes
- No Redis flush
- No `DELIVERY_RECOVERY_*` / fly.toml recovery env changes
- License auth was not weakened

**Waiting for user approval before any production deploy.**
