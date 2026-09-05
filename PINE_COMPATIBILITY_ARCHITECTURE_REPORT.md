# Kaching Stable Pine Foundation + Legacy Compatibility Layer

**Status:** Implemented locally. **DO NOT DEPLOY.** Waiting for user approval.  
**Date:** 2026-08-25  
**Production (untouched):** Fly `kaching-api` v139, Pine generation 1.3.0  
**Webhook URL (unchanged):** `https://api.kachingscanner.com/api/webhook/tradingview`  
**Alert message (unchanged):** exactly `{{alert_message}}`

This document is the durable architecture record: audit findings, compatibility matrix, Stable Pine Event Contract v1, Pine vs backend boundary, and the Part 22 implementation report.

---

## 1. Architecture before

TradingView Pine was both the **decision client** and the **schema**. Generated scripts stamped `pineClientVersion` (currently `1.3.0`) and emitted JSON via a single `alert()` gateway (`emitKachingEvent`). The backend webhook path was:

`HTTP POST /api/webhook/tradingview` → `verifyTradingViewWebhook` (license HMAC) → `acceptTradingViewWebhook` → `parseWebhookBody` → `buildSignalData` (ad-hoc field aliases) → Redis canonical lock → **optional** `claimEventId` → lifecycle → persist → HTTP 202 → async fan-out (Telegram / Email / MT5 / Socket).

Gaps that forced Pine regen cycles:

- Identity and duplicate suppression preferred Pine `eventId`, but **empty `eventId` was treated as ALLOW** (`TradeEventStore.claimEventId('')` returned `true`; accept skipped the claim when `resolveLogicalEventId` was empty). Two Fly machines could double-deliver legacy payloads.
- `isRealtime` missing (legacy) was **not rejected**, with no freshness substitute. Historical chart reload could notify.
- Field aliases (`tp1` vs `take_profit_1`, `action` vs `direction`, `ticker` vs `symbol`) were re-implemented in `kachingSignalLevels`, `SubscriberSignalFormatter`, MT5 helpers, and `buildSignalData`.
- `PineClientVersion` was diagnostic only (LEGACY / CURRENT / FUTURE). It did not normalize events. Downstream still inspected raw Pine fields.
- Every backend improvement that needed a payload field (eventId, isRealtime, canonical TF) required a new Pine stamp and subscriber regeneration.

Redis fail-closed was already in place for **non-empty** claims: production Redis down → `REDIS_UNAVAILABLE` → HTTP 503. That property is preserved.

---

## 2. Architecture after

Pine is a **stable transport client**. The backend is the **evolving intelligence and compatibility layer**.

```
RAW webhook JSON
  → DETECT (PineCompatibilityRegistry — single registry)
  → ADAPTER (Legacy | Pine12 | Pine13 | Stable — single service)
  → CANONICAL KachingTradeEvent (stable-v1)
  → Redis SET NX claimEventId (always; never empty-allow)
  → lifecycle (ENTRY-first Redis orphans, TP3/SL mutex)
  → Signal persist
  → fast-ack 202
  → async fan-out (Telegram / Email / MT5 / Socket)
```

Single sources of truth:

| Concern | Module |
|---|---|
| Public contract | `backend/contracts/KachingTradeEvent.js` |
| Adapter selection | `backend/config/PineCompatibilityRegistry.js` |
| Normalize + derive identity | `backend/services/PineCompatibilityService.js` |
| Timestamps / realtime / stale | `backend/utils/tradeEventIdentity.js` |
| Duplicate claim | `backend/utils/tradeEventStore.js` `claimEventId` |
| Lifecycle | `TradeLifecycleService` + Redis orphans |
| Subscriber presentation | `SubscriberSignalFormatter` (canonical `take_profit_*` after gateway) |

`Pine13Adapter` and `StablePineAdapter` share one normalizer. Current 1.3.0 payloads **are** Stable Contract v1; `schemaVersion` is inferred when absent. **No Pine template rewrite.**

---

## 3. All Pine versions discovered

| Version | Where | Notes |
|---|---|---|
| Unknown / pre-stamp | Live subscribers who never regenerated; test `LEGACY_ENTRY` | No `pineClientVersion`. Often `signalUuid` or only `ticker`/`action`/`tp1`. |
| 1.0.0 / 1.1.0 | `PineClientVersion` CURRENT family; tests | Same major as 1.3.0. Treated as Pine12-shaped unless modern event fields exist. |
| 1.2.x (1.2.0–1.2.2) | Prior generator stamp; smoke artifacts | Canonical TF, event bridge, `signalUuid` / `canonicalSignalKey`. Typically **no** `eventId` / `isRealtime`. |
| **1.3.0 (current generator)** | `PINE_CLIENT_VERSION`; templates + snippets | `eventId`, `canonicalTradeId`, `eventType`, `eventSequence`, `isRealtime`, `barTime`. Sole `alert()` in `emitKachingEvent`. Terminal trades DELETE all chart objects. |
| **stable-v1** | Backend contract name | Same wire fields as 1.3.0. Not a new Pine binary. New scripts stay 1.3.0 / inferred stable-v1. |

Templates (unchanged):

- `backend/templates/kaching-sweep-fvg-scalp.pine.template`
- `backend/templates/kaching-sweep-fvg-daytrading.pine.template`
- Snippets: `kaching-canon-event-arm.pine.snippet` (sole `alert()`), `kaching-canon-event-bridge.pine.snippet`, `kaching-trade-drawing.pine.snippet`, `kaching-trade-drawing-runtime.pine.snippet`

**One `alert()` call** in generated code, inside `emitKachingEvent`, gated by `barstate.isrealtime`. Message template remains `{{alert_message}}`.

### Historical change reasons (A = Pine-required, B = backend-only)

| Change | Class | Why |
|---|---|---|
| Chart drawings / DELETE on terminal | **A** | TradingView cannot be updated remotely. |
| `barstate.isrealtime` gate on `alert()` | **A** | Only Pine knows barstate. |
| Canonical TF + event bridge on the chart | **A** | Must run in Pine. |
| `eventId` + emit-once arrays | **A** (already in 1.3.0) | Chart-local exactly-once. Backend now also derives ids for older scripts. |
| Telegram / Email / MT5 copy | **B** | Formatter. |
| Duplicate suppression, Redis, Mongo, lifecycle | **B** | This project. |
| Stale / unknown realtime policy | **B** | This project. |
| Admin stats / dashboard labels | **B** | Observability fields on pipeline stamps. |
| License token CR trim | **B** | Transport artifact only. |

---

## 4. Compatibility matrix

| Capability | Legacy unknown | 1.2.x | 1.3.0 | Stable foundation |
|---|---|---|---|---|
| Adapter | `LegacyPineAdapter` | `Pine12Adapter` | `Pine13Adapter` | `StablePineAdapter` |
| Mode | Adapted | Adapted | Native | Native |
| `pineClientVersion` | missing | `1.2.x` | `1.3.0` | inferred / optional `schemaVersion: stable-v1` |
| `eventId` | **derived** (deterministic) | derived from uuid+type | Pine-supplied | Pine-supplied |
| `canonicalTradeId` | **derived** hash `leg-…` | `signalUuid` / key | Pine-supplied | Pine-supplied |
| `eventSequence` | inferred from type | inferred | Pine-supplied | Pine-supplied |
| `isRealtime` | **unknown** → freshness | **unknown** → freshness | true/false | true/false |
| Identity model | user+symbol+tf+side+prices+coarse time bucket | uuid | uuid / canonicalTradeId | same as 1.3.0 |
| Field names | `ticker`,`action`,`tp1`,`sl` | `take_profit_*`,`direction` | same + event meta | same |
| Drawings | old visual bugs **cannot** be fixed remotely | 1.2 retention bugs stay on chart | terminal DELETE-all | frozen with 1.3.0 |
| Backend alerts | delivered via compatibility | delivered | native | native |
| Empty eventId | **no longer ALLOW** | derived then claimed | claimed | claimed |

Detection priority: (1) `pineClientVersion` (2) `schemaVersion` (3) capabilities (`hasEventId`, `hasCanonicalTradeId`, `hasEventSequence`, `hasRealtimeFlag`, `hasStableSchema`) (4) heuristics (`tp1`, `action`, ticker-only) (5) legacy fallback. **Missing version never rejects.**

---

## 5. Canonical event contract

Public API: **Kaching Stable Pine Event Contract v1** (`schemaVersion: "stable-v1"`).

Do not casually rename or remove fields. Additive optional fields only. A future v2 must still accept v1.

```js
{
  schemaVersion: "stable-v1",
  source: { platform, pineVersion, compatibilityMode: "native"|"adapted" },
  identity: { eventId, canonicalTradeId, signalUuid, symbol, canonicalTimeframe },
  event: { type: ENTRY|TP1|TP2|TP3|SL|CANCELLED|EXPIRED, sequence, timestamp, isRealtime: true|false|"unknown" },
  trade: { side: BUY|SELL, entry, tp1, tp2, tp3, sl },
  security: { userId, tradingViewUsername, scriptGenerationId, tokenVersion: kls_v1|kls_v2 },
  metadata: { originalPineVersion, receivedAt, compatibilityAdapter, legacy, capabilities, identityDerived, schemaInferred }
}
```

1.3.0 already emits these wire fields (`eventId`, `canonicalTradeId`, `eventType`, `eventSequence`, `isRealtime`, `alertType`, levels). The generator is **not** rewritten to stamp `schemaVersion`; the gateway infers it.

---

## 6. Legacy adapters created

Registered only in `PineCompatibilityRegistry` / `PineCompatibilityService` (no unused experimental copies):

- `LegacyPineAdapter` — unknown / pre-1.2 / camelCase `tp1` / `action` / ticker-only
- `Pine12Adapter` — 1.2.x and 1.x without modern event meta; uses uuid when present
- `Pine13Adapter` — 1.3.0 family; shared stable normalizer
- `StablePineAdapter` — explicit `schemaVersion: stable-v1`; same normalizer as 1.3.0

---

## 7. How missing `eventId` is derived

Never random UUID. Never HTTP receipt time.

1. If Pine sent `eventId` / `event_id` → use it (validated non-empty).
2. Else `resolveLogicalEventId`: `compactSymbol|canonicalTf|canonicalTradeId|EVENTTYPE` (same shape as 1.3.0 `makeKachingEventId`).
3. Else `deriveLegacyEventId` with the same pattern after a derived trade id.

`TradeEventStore.claimEventId('')` now **throws** `missing_event_identity` instead of returning `true`. Accept always claims; if identity is still empty → HTTP 409, not allow.

---

## 8. How missing `canonicalTradeId` is derived

Priority: explicit `canonicalTradeId` → `signalUuid` / `signalId` / `signalGroupId` / `canonicalSignalKey` → **deterministic** `deriveLegacyCanonicalTradeId()`:

`SHA256("legacy|userId|SYMBOL|tf|SIDE|entry|tp1|tp2|tp3|sl|timeBucket").slice(0,24)` → `leg-{hash}`

- Prices: 8-decimal identity rounding (1.1 and 1.10000000 match).
- Time bucket: `max(expiryBars * barMs, 1h)` so ENTRY and later TP/SL of the same setup stay together. **Not** per-event bar time (that would split a trade). **Not** HTTP `receivedAt`.
- `scriptGenerationId` is **omitted** from the hash so ENTRY-with-id and TP-without-id cannot split.
- BUY vs SELL at the same prices → different ids.
- Same webhook twice, two Fly machines → same id.

---

## 9. How legacy stale events are handled

`isRealtime`:

| Value | Behavior |
|---|---|
| `true` | Normal path. Existing `MAX_ENTRY_SIGNAL_AGE_MS` (30m, 3-bar floor) still applies to entries. |
| `false` | Reject subscriber delivery: `non_realtime_event` (HTTP 202, no fan-out). |
| missing | State **`unknown`**. Log `legacy_realtime_unknown` once per event (`Compatibility / N/A`, does not increment failure counters). Freshness vs **event** timestamp (`signalTime` / `timestamp` / `barTime`) compared to `receivedAt`. |

Unknown freshness:

- Entry: `MAX_LEGACY_ENTRY_AGE_MS` (default 30 minutes)
- Outcome: `MAX_LEGACY_OUTCOME_AGE_MS` (default 2 hours)
- Missing timestamp: **not** rejected (cannot prove replay)

HTTP receipt is never stored as the event timestamp.

---

## 10. Duplicate suppression across versions

Flow: normalize → canonical `eventId` → Redis `SET NX` `kaching:trade:eid:{eventId}` → only first proceeds.

- 1.3.0 / stable: Pine `eventId` (ticker\|tf\|trade\|TYPE)
- 1.2.x: derived from uuid + type
- Legacy: derived from `leg-` trade id + type
- Same TP1 twice → same eventId → second is `duplicate_event_id`
- TP1 vs TP2 → different eventId
- **Eliminated:** empty eventId automatic allow

---

## 11. ENTRY-first ordering

Unchanged Redis orphan mechanism (`putOrphan` / `takeOrphans` / `markEntryReady`). No fake ENTRY. No process-local memory as distributed authority. Shared Redis for legacy **and** modern because they now share `canonicalTradeId` even when Pine omitted it.

TP3 / SL remain exclusive (`hasLifecycleEvent` mutex on the canonical id).

---

## 12. Redis authority

Production (`NODE_ENV=production` or `TRADE_EVENT_REQUIRE_REDIS=1`): Redis down → `redis_unavailable` → HTTP **503**. Process-local Maps are tests / explicit `TRADE_EVENT_ALLOW_MEMORY` only.

`claimEventId`, `claimLifecycleEvent`, `claimFanout`, canonical lock: fail closed. Empty eventId is no longer a silent local win.

---

## 13. Token compatibility

`LicenseTokenService` + `WEBHOOK_SIGNING_SECRET` unchanged. Both **kls_v1** (verify-only) and **kls_v2** (mint) remain.

Safe transport normalize **only**: trim outer whitespace / CR / LF / BOM. **Does not** rewrite characters inside the token. Inner CR (Pine `jsonEsc` corruption) still fails HMAC.

Tests: kls_v1+trailing CR valid; kls_v2 outer CR/LF valid; tampered reject; non-production env claim rejected in production runtime.

---

## 14. Files changed

**Created**

- `backend/contracts/KachingTradeEvent.js`
- `backend/config/PineCompatibilityRegistry.js`
- `backend/services/PineCompatibilityService.js`
- `backend/utils/__tests__/pineCompatibilityLayer.test.js`
- `backend/PINE_COMPATIBILITY_ARCHITECTURE_REPORT.md` (this file)

**Modified**

- `backend/services/TradingViewAlertService.js` — gateway in `buildSignalData`; always `claimEventId`; unknown realtime freshness
- `backend/utils/tradeEventStore.js` — empty eventId throws `missing_event_identity`
- `backend/utils/tradeEventIdentity.js` — `evaluateUnknownRealtimeFreshness`, `MAX_LEGACY_*`
- `backend/services/LicenseTokenService.js` — `normalizeLicenseTokenTransport`
- `backend/utils/pipelineLog.js` — compatibility observability fields
- `backend/services/PipelineStatusService.js` — stamp + `pineCompatibility` admin labels
- `backend/utils/PineClientVersion.js` — `STABLE_PINE_SCHEMA_VERSION` constant only (stamp still `1.3.0`)
- `backend/services/__tests__/licenseTokenService.test.js` — CR tests; tamper always mutates signature

**Not changed:** webhook URL, `{{alert_message}}`, M-Pesa, MT5 pairing, subscription tiers, payment logic, `WEBHOOK_SIGNING_SECRET`, kls cryptography, user records, Pine templates/snippets.

---

## 15. Which Pine files changed

**None.**

---

## 16. Why each Pine change was unavoidable

**N/A — zero Pine template/snippet changes.** 1.3.0 already carries the stable wire contract. Backend absorbs formatting, identity, duplicates, stale, and observability.

---

## 17. Test results (targeted new tests)

`node --test utils/__tests__/pineCompatibilityLayer.test.js`

Covers spec A–J:

| Spec | Result |
|---|---|
| A version detection | pass |
| B field normalization | pass |
| C legacy identity (deterministic, BUY/SELL, TP1 vs TP2) | pass |
| D Redis SET NX + empty eventId throw + prod 503 | pass |
| E realtime true/false/unknown fresh/stale | pass |
| F ENTRY-first orphans; TP3/SL exclusive | pass |
| G e2e legacy / 1.2 / 1.3 / stable + dup ENTRY | pass |
| H persist once per eventId | pass |
| I legacy tokens (licenseTokenService CR + kls_v1/v2) | pass |
| J 1.3.0 regression (stamp, shared normalizer, levels) | pass |

Related regressions (all pass): `pineClientArchitecture`, `kachingAlertOnce`, `webhookFastAck`, `signalOrderingStale`, `distributedLifecycleFix`, `phase16PreDeployValidation`, `optionACanonicalTf`, `licenseTokenService`.

---

## 18. Full regression results

```
node --test strategies/__tests__/**/*.test.js utils/__tests__/**/*.test.js middleware/__tests__/**/*.test.js services/__tests__/**/*.test.js

ℹ tests 657
ℹ suites 150
ℹ pass 655
ℹ fail 0
ℹ skipped 2
duration_ms ~139000
```

Skipped: MT5 pairing Redis integration when local Redis is down (pre-existing skip, not the `dev-users.json` parallel flake). The known flake (`mt5Pairing.test.js` + `mt5ReliabilityHardening.test.js` sharing `backend/dev-users.json`) **did not occur** in this run.

---

## 19. Known limitations

- **Old Pine chart drawings cannot be fixed remotely.** Compatibility delivers backend alerts; leftover boxes/labels on 1.2.x charts stay until the user deletes alerts / regenerates.
- Legacy identity without uuid uses a coarse time bucket. Two identical setups from the same user in the same window can collapse to one trade (safer than splitting ENTRY vs TP).
- Unknown realtime with **no** event timestamp cannot be proven stale (same as prior missing-timestamp policy).
- `SubscriberSignalFormatter` still accepts alias fields as a belt-and-suspenders read path; after the gateway, canonical `take_profit_*` is always present. Not a second adapter.
- `PineClientRegistry` remains generation/webhook **observability** for subscriber script versions; it does not select adapters.
- Weight-learning debounce after TP3 can keep the Node test process ~60s (pre-existing). Not a production webhook issue.

---

## 20. Can we upgrade the backend without requiring subscribers to change Pine?

**Yes, for category A (backend-only).** Existing unknown / 1.2.x / 1.3.0 scripts keep working. New generator output stays 1.3.0 / inferred stable-v1 without a mass regen.

| Class | Meaning | Examples |
|---|---|---|
| **A — backend-only** | Ship without any Pine change | Telegram/Email/MT5 templates, duplicate rules, Redis, Mongo, lifecycle, admin stats, dashboard, retries, stale windows, risk notes, observability |
| **B — optional Pine** | Better charts / metadata for **new** scripts only; old scripts keep working | Optional `schemaVersion` stamp, extra diagnostic fields, drawing polish for new users |
| **C — mandatory Pine** | Only if TV must compute something the backend cannot know | New drawing primitives, new barstate-derived flags, strategy math that must run on the chart |

**Do not** rotate `WEBHOOK_SIGNING_SECRET` or require mass regen for A/B.

---

## 21. Deployment readiness checklist

- [x] Audit + matrix complete
- [x] Gateway wired at accept/parse (`buildSignalData` → all inject/webhook paths)
- [x] Empty eventId allow-bypass removed
- [x] Redis fail-closed preserved
- [x] Fast-ack 202 unchanged
- [x] Webhook URL unchanged
- [x] `{{alert_message}}` unchanged
- [x] kls_v1 + kls_v2 preserved
- [x] Zero Pine template changes
- [x] Tests green (655 pass / 0 fail / 2 skipped)
- [ ] **User approval to deploy**
- [ ] Deploy Fly `kaching-api` (NOT done)
- [ ] Confirm two machines still fail-closed on Redis
- [ ] Confirm a 1.3.0 and a legacy webhook both 202 in production after approval

---

## 22. Confirm DO NOT DEPLOY

**Waiting for user approval. No Fly deploy, no git commit, no git push, no secret rotation, no user-script regeneration.**

---

## Pine vs backend boundary (Part 9)

Change Pine **only** when TradingView must calculate or emit something the backend cannot know:

- Chart drawings and object deletion
- `barstate.isrealtime` / `barstate.isconfirmed`
- Wick vs close hits on canonical bars
- UUIDs frozen at arm time on the chart

Everything else (delivery copy, duplicates, Redis, Mongo, lifecycle, admin, stale, risk presentation) is backend. Stable foundation is frozen at 1.3.0 wire shape.

**Drawings (Part 14):** Product rule remains: no drawing remains when no active trade (1.3.0 already DELETEs all objects on terminal). Old Pine visual bugs are not remotely fixable; backend alerts still go out through compatibility. Do not require Pine updates for backend drawing-policy docs.

**Observability (Part 16):** Pipeline stamps may include `detectedPineVersion`, `compatibilityAdapter`, `compatibilityLabel` (`Native` vs `Adapted`), `legacy`, `canonicalTradeId`, `eventId`, `eventType`, `eventSequence`, `isRealtimeState`, `staleDecision`, `duplicateDecision`. Never license tokens, webhook secrets, Redis URLs, Telegram tokens, or email credentials. Admin: **Pine Version + Compatibility Native vs Adapted**.

---

## Migration policy (Part 20)

| Group | Policy |
|---|---|
| **LEGACY SUPPORTED** | Unknown / 1.0 / 1.1 / 1.2.x keep working via adapters. No regen required. |
| **CURRENT 1.3.0 SUPPORTED** | Production generator stamp. Native path. No regen required for backend upgrades. |
| **STABLE FOUNDATION** | Same wire as 1.3.0 (`stable-v1`). New users get 1.3.0; optional later `schemaVersion` is additive. |

Future backend changes should not require any group to change Pine unless class C.

---

## Success criteria 1–12

1. **Old Pine versions still work** — Yes. Legacy + 1.2.x e2e accept + duplicate suppression.  
2. **Current 1.3.0 unchanged for existing users** — Yes. No template edits; regression tests keep stamp `1.3.0`, `eventId`, levels.  
3. **New Pine is a long-term stable foundation** — Yes. 1.3.0 wire **is** stable-v1; shared normalizer.  
4. **Backend upgrades without forcing Pine regen** — Yes for class A.  
5. **One canonical event after ingest** — Yes. `KachingTradeEvent` via `normalizeIncomingPineEvent`.  
6. **Duplicate suppression for all versions** — Yes. Derived or native `eventId` always claimed.  
7. **Missing eventId no longer auto-allows** — Yes. Derive or 409; `claimEventId('')` throws.  
8. **Legacy realtime unknown uses freshness, not silent allow of ancient events** — Yes.  
9. **Redis remains production authority / fail-closed** — Yes.  
10. **License tokens: kls_v1 + kls_v2, outer CR only** — Yes. Inner CR still HMAC-fails.  
11. **Fast-ack and webhook URL unchanged** — Yes.  
12. **Not deployed** — Confirmed. Waiting for approval.

---

## Wire-up

`TradingViewAlertService.buildSignalData` (used by `acceptTradingViewWebhook` and inject paths):

`parse → normalizeIncomingPineEvent → applyCanonicalToRawBody → existing mapping → attachCanonicalMetadata → validate → lock → claimEventId → lifecycle → persist → 202 → async fan-out`
