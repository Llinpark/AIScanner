# Pine Stable Client Architecture

**Status:** Phase 16 pre-deploy validated (local only) — 2026-08-07  
**Scope:** Additive versioning + clean interfaces. Feature flags default OFF. No production behaviour change. No deploy / no commit / no merge.  
**Goal:** Make generated TradingView Pine a **stable client** long-term: chart-local market detection stays in Pine; frequently tuned business decisions move to backend/config.

---

## 1. Current architecture

```
Admin Strategy Configuration (TF allowlists, thresholds, TP profiles)
        │
        ▼
PineScriptGeneratorService.generateForUser()
  • loads scalp OR daytrading .pine.template
  • injects {{…}} vars from strategyRuntimeConfig + strategyArchitecture
  • stamps pineClientVersion / scriptGenerationId / generatedAt / capabilities
  • inlines snippets/kaching-trade-drawing.pine.snippet as {{DRAWING_ENGINE}}
        │
        ▼
Subscriber pastes Pine on TradingView chart
  • Sweep / MSS / Displacement / FVG / Retrace evaluated bar-by-bar
  • confScore() + confThreshold gate fireLong/fireShort
  • calcLevels() builds Entry/SL/TP1–3 (RR + optional ATR caps)
  • drawings + alert(JSON) arm on same confirmed event
  • webhook JSON includes additive version fields (new regenerations only)
        │
        ▼
POST /api/webhook/tradingview
  • auth via licenseToken + TV username
  • levels/confidence trusted from payload (no rescoring)
  • optional pineClientVersion / capabilities parsed; missing ⇒ Legacy Mode
  • PineClientRegistry updated fire-and-forget (never gates delivery)
  • Mongo → Socket.IO → Telegram → MT5 → Dashboard
```

**Truth today:** TradingView Pine is the sole production signal source (`docs/ARCHITECTURE.md`). Backend `ScalpingStrategy` / `DayTradingStrategy` mirror the math for offline/admin/tests, but live distribution does **not** recalculate levels from provider candles.

**Already partially “config-driven at generate time”:** thresholds are baked into Pine inputs when the script is generated. Changing admin config still requires **subscriber regenerate + re-paste + recreate alert** — that churn is the problem this design targets.

---

## 2. Future architecture (target)

```
Pine (stable client, rare updates)
  • Group A market detection only
  • Emits rich context + raw geometry on webhook
  • Does NOT apply tunable gates (confidence threshold, smart TP ranking, style filters, feature flags)
        │
        ▼
Backend decision layer (version-aware)
  • Reads pineClientVersion / capabilities from payload (or generation registry)
  • Applies Group B: confidence, TP model, filters, notifications, delivery rules
  • Feature flags decide behavior without Pine reinstall when capability is present
        │
        ▼
Existing delivery pipeline (schema-compatible)
```

**Invariant preserved:** chart-bar Sweep/MSS/FVG detection cannot leave TradingView. Backend never invents entries from Twelve Data / EODHD.

**Transition rule:** additive webhook fields + backend gates; old Pine generations keep working until subscribers naturally upgrade.

---

## 3. Version flow (implemented prep)

| Field | Where set | Required? |
|-------|-----------|-----------|
| `pineClientVersion` | Generator stamp → Pine comment + every `buildPayload` JSON | No (missing ⇒ Legacy) |
| `generatedAt` | Generator ISO timestamp | No |
| `scriptGenerationId` | Unique per `generateForUser` call | No |
| `capabilities` | Generator list (currently `["v1_payload"]` only) | No |
| `scriptId` | Existing per-user hash (identity, not version) | Existing |

**Constant:** `PINE_CLIENT_VERSION = "1.1.0"` in `backend/utils/PineClientVersion.js` (generator stamp).

**Important:** Any client in the stamped major family (`1.x`, including earlier `1.0.0` payloads) is **CURRENT** for negotiation. Decision path still trusts Pine confidence + levels while feature flags are OFF. Backend scoring / TP rewrite / filtering are **not** enabled.

**Upgrade reality:** Existing pasted scripts do **not** auto-update. New version fields appear only after regenerate + re-paste + recreate alert. Old scripts without version fields continue to work forever under Legacy Mode.

### Compatibility modes

| Mode | When | Behaviour today |
|------|------|-----------------|
| **Legacy** | Missing / unparseable version, or older major than stamp | Trust payload; no new gates |
| **Current** | Same major as stamp (`1.0.0` and `1.1.0` while stamp is `1.1.0`) | Same delivery path; flags still OFF |
| **Future** | Higher major than backend stamp | Accepted; new gates stay off until flagged |

Never reject old Pine clients. Version metadata is never required for auth, persist, or delivery.

---

## 4. Capability negotiation (implemented prep)

Backend parses `capabilities` as array **or** comma/space string. Unknown tokens are ignored (not rejected).

| Capability | Claimed by current Pine? | Meaning |
|------------|--------------------------|---------|
| `v1_payload` | **Yes** | Standard entry/levels/confidence webhook |
| `factors_v1` | No | Confidence factor flags (future) |
| `adaptive_tf` | No | TF policy context (future) |
| `dynamic_tp` | No | Dynamic TP context (future) |
| `smart_score` | No | Smart scoring inputs (future) |
| `liquidity_targets` | No | Liquidity pool hints (future) |
| `trend_bias` | No | HTF bias flags (future) |
| `atr_context` | No | ATR / volatility context (future) |
| `context_atr` | No | Alias reserved for ATR context negotiation |
| `provisional_tps` | No | Provisional TP hints (future) |

Modules: `backend/utils/PineClientVersion.js` (`parseCapabilities`, `negotiateCapabilities`, `extractPineClientMeta`).

---

## 5. Backend version registry (implemented prep)

`backend/services/PineClientRegistry.js`

- In-memory map + additive `UserConfig.pineClientRegistry` Mongo fields
- Updated on pine generate (`recordGeneration`) and after webhook auth (`recordWebhookVersion`)
- Fire-and-forget; failures never fail webhook/auth/delivery
- **Does not** gate subscription, auth, Telegram, or MT5

Tracks: subscriber, script version, generated date, capabilities, last webhook version.

---

## 6. Feature flags (implemented prep — all default OFF)

`backend/utils/FeatureFlags.js`

| Flag | Env | Default |
|------|-----|---------|
| `enableAdaptiveTF` | `ENABLE_ADAPTIVE_TF` | OFF |
| `enableDynamicTP` | `ENABLE_DYNAMIC_TP` | OFF |
| `enableSmartScore` | `ENABLE_SMART_SCORE` | OFF |
| `enableTrendBias` | `ENABLE_TREND_BIAS` | OFF |
| `enableLiquidityRanking` | `ENABLE_LIQUIDITY_RANKING` | OFF |
| `enableATRTargets` | `ENABLE_ATR_TARGETS` | OFF |

When OFF: zero behaviour change vs pre-prep. Flags are version-gated via capability matrix in future phases.

**Not the same as Pine template `{{ENABLE_DYNAMIC_TP}}`:** that injects the existing chart-side dynamic-TP *input default* into generated Pine. It does **not** flip `FeatureFlags.enableDynamicTP` / backend decision gates. Backend flags are unset in `.env.example` and have no accidental activation path from pine-gen.

---

## 7. Decision framework + shadow mode (stubs only)

`backend/services/PineClientDecisionFramework.js`

Pass-through methods: `scoreConfidence`, `applyDynamicTakeProfits`, `applyAdaptiveTfPolicy`, `applyTrendBias`, `applyLiquidityRanking`, `evaluateEntryDecision`.

- Hooked after signal build for readiness only; **result is discarded** — does not alter delivery
- Legacy + Current (`1.x` / `v1_payload`) ⇒ early pass-through (Pine authoritative for entry/confidence/SL/TP)
- Future majors run stub hooks but still return `proceed: true` (no Group-B implementations yet)
- `shadowMode` placeholder reserved for future log-only rescoring comparisons
- **Do not enable** backend scoring / TP generation / filtering until product decision + flags ON + capability present

**Extension path without subscriber reinstall (once capable Pine is already pasted):**
- **v2:** optional context fields (`PineWebhookContext`) accepted additively; ignored when absent
- **v3:** backend decision stubs + feature flags can activate Group-B behaviour for clients advertising the needed capabilities — old scripts without those fields remain Legacy forever

---

## 8. Context-only webhooks (parsers ready)

`backend/utils/PineWebhookContext.js` accepts optional fields if present:

`atr14`, `volatility`, `htfBias`, `sweepQuality`, `fvgSize`, `trendStrength`, `confidenceFactors`, `hasEngulfing`

Absent ⇒ ignored. Old payloads remain valid. No delivery change.

---

## 9. Inventory — business logic that changes frequently

Citations below apply to **both** templates unless noted (daytrading ↔ scalp are near-identical; line numbers match for strategy math). Drawing engine lines refer to the shared snippet.

### 9.1 Injected at generate time (already backend-owned values, still require Pine reinstall)

| Concern | Template lines | Injected by |
|--------|----------------|-------------|
| HTF default TF | day/scalp `27` `{{HTF_TF}}` | `buildPineTfVariables` → `PineScriptGeneratorService.buildSweepVariables` |
| Swing sensitivity / EQH-EQL tol | `28–29` | from `config.swing` |
| Displacement ratios | `31–33` | from `config.displacement` |
| Min FVG/ATR | `35` | from config |
| Entry / stop model | `36–37` | from config |
| TP R multiples | `38–40` | from config |
| Dynamic TP flag + ATR caps | `41–44` | from config |
| Confidence threshold | `45` | from config |
| Require engulfing | `46` | from config |
| Strategy key + TF advisory exprs | `56–70` | `strategyArchitecture.buildPineTfVariables` |
| Trading style expression | `70` `{{TRADING_STYLE_EXPR}}` | `TradingStyleClassifier.buildPineTradingStyleExpression` |
| Version metadata | header + `buildPayload` | `PineClientVersion` + generator |
| License / webhook / subscriber | `14–17`, payload | base vars |

### 9.2 Hardcoded in Pine (high churn / drift risk)

| Concern | Notes |
|--------|-------|
| **Confidence weights** | Hardcoded in Pine; scalp config match; daytrading weights may drift |
| Confidence gate on fire | `confScore() >= confThreshold` |
| Sweep / MSS / Disp / FVG windows | Hardcoded bar windows |
| Body-vs-avg / close-near-extreme / CE band / SL ATR buffer | Hardcoded scalars |
| ATR period | `ta.atr(14)` |

### 9.3 Backend-only today (already Group B, not in Pine)

- Full **smart_scoring** liquidity ranking / TP source selection
- Spread / news / sideways filters
- Telegram / MT5 delivery rules
- Dashboard / UI presentation

---

## 10. Group A — must remain in Pine forever

Bar-by-bar chart context that TradingView alone has in realtime: HTF `request.security`, Sweep/MSS/Displacement/FVG geometry, `barstate.isconfirmed` fire arming, on-chart drawings, trade lifecycle hit detection for chart cleanup, license confirm UX, minimal webhook emission of detected geometry + prices.

---

## 11. Group B — can safely move to backend/config

Confidence threshold/weights, preferred TF advisory, dynamic TP / ATR caps as delivery decisions, smart score / liquidity ranking, require-engulfing filters, feature flags, notification copy, MT5 sizing, dashboard ranking.

---

## 12. Migration path / upgrade strategy

| Phase | Status | Notes |
|-------|--------|-------|
| M1 Version + capability headers | **Done (prep)** | Additive; old clients Legacy |
| M2 Emit confidence factors | Not started | Keep `confidence` 0–1 field |
| M3 Stop Pine confidence gate | Not started | High UX risk — dual-run / shadow first |
| M4 Align daytrading weights | Not started | Fix drift before authority move |
| M5 Backend authoritative TP | Not started | Product policy required |
| M6 Feature flags service | **Done (prep, OFF)** | Env + module |
| M7 Generation registry | **Done (prep)** | Observability only |
| M8 Collapse dual templates | Not started | Future |

**Subscriber upgrade:** regenerate only when client capabilities are needed. This prep does **not** require subscribers to regenerate to keep trading.

**Shadow mode (future):** log backend would-score / would-filter vs Pine without changing delivery; enable only under explicit flag.

---

## 13. Capability Matrix

| Capability / change | Requires Pine Update? |
|---------------------|------------------------|
| Confidence threshold change (once backend gates) | **NO** |
| TP RR / ATR tuning (delivery, once backend) | **NO** |
| Telegram / MT5 / UI | **NO** |
| Webhook optional field add | **NO** for old clients (ignore) |
| Market detection Sweep/MSS/FVG algo change | **YES** |
| Drawing engine change | **YES** |
| Webhook required field rename/remove | **YES** (avoid) |

---

## 14. Files changed in this prep implementation

- `backend/utils/PineClientVersion.js` (new)
- `backend/utils/FeatureFlags.js` (new)
- `backend/utils/PineWebhookContext.js` (new)
- `backend/services/PineClientRegistry.js` (new)
- `backend/services/PineClientDecisionFramework.js` (new)
- `backend/services/PineScriptGeneratorService.js` — stamp metadata
- `backend/templates/kaching-sweep-fvg-*.pine.template` — additive payload fields
- `backend/services/TradingViewAlertService.js` — parse/attach metadata (non-gating)
- `backend/server.js` — registry hooks after auth / pine-gen
- `backend/models/User.js` — additive `pineClientRegistry`
- `docs/PINE_STABLE_CLIENT_ARCHITECTURE.md` — this document
- Tests under `backend/utils/__tests__/` and `backend/services/__tests__/`

## 15. Files intentionally untouched (behaviour)

- Auth / license HMAC algorithms
- Sweep/MSS/FVG/Entry/Score/SL/TP calculation paths
- TelegramService / TradeDeliveryService outcomes
- Mongo Signal required schema / Redis / MT5 bridge internals
- Production deploy config / Fly / Wrangler

---

## 16. Verification checklist

- [x] Feature flags default OFF
- [x] Legacy payloads without version fields accepted
- [x] Unknown capabilities ignored
- [x] Registry never fails webhook / pine-gen
- [x] Decision framework pass-through only (result discarded on webhook path)
- [x] Pine payload additive-only (`pineClientVersion`, `generatedAt`, `scriptGenerationId`, `capabilities`)
- [x] Phase 15 local architecture verification (no deploy / no commit)
- [x] Phase 16 pre-deploy validation (Legacy / v1 / future 5.0.0 / per-flag ON / registry failure / payload parity / perf / memory / full `npm test` + `smoke-pine-gen`) — no deploy / no commit / no merge
- [ ] Shadow-mode dual-run (future)
- [ ] Backend-authoritative scoring/TP (future, product decision)
