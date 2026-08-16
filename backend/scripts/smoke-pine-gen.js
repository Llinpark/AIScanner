process.env.TRADINGVIEW_WEBHOOK_SECRET =
  process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
process.env.WEBHOOK_SIGNING_SECRET =
  process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';

const P = require('../services/PineScriptGeneratorService');

const day = P.generateForUser(
  {
    _id: '507f1f77bcf86cd799439011',
    email: 't@test.com',
    tradingviewUsername: 'demo_trader',
    subscription: { tier: 'professional', status: 'active' }
  },
  { strategy: 'daytrading' }
);

const scalp = P.generateForUser(
  {
    _id: '507f1f77bcf86cd799439011',
    email: 't@test.com',
    tradingviewUsername: 'demo_trader',
    subscription: { tier: 'professional', status: 'active' }
  },
  { strategy: 'scalping' }
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Static Pine audit: find `:=` / `+=` / `-=` assignments to known globals
 * inside function bodies. Also flag array.push/set/clear on those globals
 * inside functions (Pine forbids modifying global state from functions).
 */
function auditGlobalMutationInFunctions(script, label) {
  const GLOBAL_NAMES = [
    'tradeActive',
    'tradeState',
    'lineAge',
    'lbBadge',
    'lblBadge',
    'fvgZone',
    'activeEntry',
    'activeSl',
    'activeTp1',
    'activeTp2',
    'activeTp3',
    'activeGapTop',
    'activeGapBot',
    'activeDirection',
    'activeSignalId',
    'activeEntryBar',
    'tp1Alerted',
    'tp2Alerted',
    'tradeFloats',
    'tradeStrings',
    'tradeFlags',
    'tradeLevelLines',
    'tradeLevelLabels',
    'tradeLeaderLines',
    'tradeBadgeHold',
    'tradeFvgHold',
    'tradeLabelYs',
    'tradeLayoutSide',
    'tradeLayoutStep',
    'lnEntry',
    'lnSl',
    'lnTp1',
    'lnTp2',
    'lnTp3',
    'pendingDrawSide',
    'pendingDrawSignalId',
    'pendingDrawEntry'
  ];

  const lines = script.split(/\r?\n/);
  const violations = [];
  let inFunction = false;
  let funcName = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    const fnMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(.*\)\s*=>\s*$/);
    const fnInline = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(.*\)\s*=>\s*\S/);
    if (fnMatch) {
      inFunction = true;
      funcName = fnMatch[1];
      continue;
    }
    if (fnInline) {
      const name = fnInline[1];
      for (const g of GLOBAL_NAMES) {
        const reAssign = new RegExp(`\\b${g}\\s*(:=|\\+=|-=)`);
        const reArray = new RegExp(`array\\.(push|set|clear|unshift|remove|pop)\\(\\s*${g}\\b`);
        if (reAssign.test(trimmed) || reArray.test(trimmed)) {
          violations.push({ line: i + 1, func: name, global: g, text: trimmed });
        }
      }
      continue;
    }

    if (inFunction) {
      if (trimmed === '') {
        // keep
      } else if (!line.startsWith('    ') && !line.startsWith('\t') && !trimmed.startsWith('//')) {
        inFunction = false;
        funcName = '';
      } else {
        for (const g of GLOBAL_NAMES) {
          const reAssign = new RegExp(`\\b${g}\\s*(:=|\\+=|-=)`);
          const reArray = new RegExp(`array\\.(push|set|clear|unshift|remove|pop)\\(\\s*${g}\\b`);
          if (reAssign.test(trimmed) || reArray.test(trimmed)) {
            violations.push({
              line: i + 1,
              func: funcName,
              global: g,
              text: trimmed
            });
          }
        }
      }
    }
  }

  if (violations.length) {
    const detail = violations
      .map(v => `  L${v.line} in ${v.func}(): ${v.global} — ${v.text}`)
      .join('\n');
    throw new Error(`${label}: Pine global-mutation-in-function violations (${violations.length}):\n${detail}`);
  }
  return true;
}

for (const [label, g] of [
  ['daytrading', day],
  ['scalping', scalp]
]) {
  assert(g.script.includes('tradeIsActive()'), `${label}: missing tradeIsActive for replace/clear`);
  assert(g.script.includes('resolveValidStop'), `${label}: missing resolveValidStop`);
  assert(g.script.includes('maxStopAtrMult'), `${label}: missing maxStopAtrMult`);
  assert(g.script.includes('SIGNAL_REJECTED_SL_TOO_FAR'), `${label}: missing SL reject log`);
  assert(g.script.includes('new_confirmed_setup'), `${label}: missing replace reason`);
  assert(g.script.includes('jsonEsc'), `${label}: missing jsonEsc`);
  assert(g.script.includes('expiryBars'), `${label}: missing expiryBars`);
  assert(g.script.includes('enableTradeExpiry'), `${label}: missing enableTradeExpiry`);
  assert(g.script.includes('buildTradeDrawings'), `${label}: missing pure buildTradeDrawings`);
  assert(g.script.includes('makeCanonicalSignalId'), `${label}: missing canonical signal id helper`);
  assert(g.script.includes('signalUuid'), `${label}: missing signalUuid in payload`);
  assert(g.script.includes('array.set(tradeFlags'), `${label}: missing array-based trade flags`);
  assert(g.script.includes('tradeBadgeHold'), `${label}: missing tradeBadgeHold (no lbBadge scalar)`);
  assert(!g.script.includes('isSupportedSymbol'), `${label}: must not gate on isSupportedSymbol`);
  assert(!g.script.includes('symbolOk'), `${label}: must not gate on symbolOk`);
  assert(!/Unsupported Symbol/i.test(g.script), `${label}: must not show Unsupported Symbol banner`);
  assert(g.script.includes('syminfo.ticker'), `${label}: must use syminfo.ticker for TV instrument`);
  assert(g.script.includes('format.mintick'), `${label}: must format prices via format.mintick`);
  assert(!g.script.includes('priceDecimals'), `${label}: must not use symbol-specific priceDecimals`);
  assert(!/str\.contains\(t,\s*"JPY"\)/.test(g.script), `${label}: must not hardcode JPY price precision`);
  assert(!/str\.contains\(t,\s*"XAU"\)/.test(g.script), `${label}: must not hardcode XAU price precision`);

  assert(g.script.includes('tradeLabelYs'), `${label}: missing tradeLabelYs layout state`);
  assert(g.script.includes('tradeLayoutSide'), `${label}: missing tradeLayoutSide state`);
  assert(g.script.includes('line.set_xy1'), `${label}: missing live line glue set_xy1`);
  assert(g.script.includes('line.set_xy2'), `${label}: missing live line glue set_xy2`);
  assert(!g.script.includes('Kaching Buy · TP1'), `${label}: must not mix Buy badge with TP1 text`);
  assert(!g.script.includes('Kaching Buy · TP2'), `${label}: must not mix Buy badge with TP2 text`);
  assert(!g.script.includes('drawBuySignal'), `${label}: drawBuySignal must be inlined at main scope`);
  assert(!g.script.includes('drawSellSignal'), `${label}: drawSellSignal must be inlined at main scope`);
  assert(!g.script.includes('function closeActiveTrade'), `${label}: closeActiveTrade must be inlined at main scope`);
  assert(!g.script.includes('function clearPreviousTrade'), `${label}: clearPreviousTrade must be inlined at main scope`);
  assert(!/\blbBadge\b/.test(g.script), `${label}: must not use lbBadge`);
  assert(!/\blblBadge\b/.test(g.script), `${label}: must not use lblBadge`);
  assert(!g.script.includes('SEND_CANDLE_FEED'), `${label}: must not include candle feed`);
  assert(g.script.includes('setupLong = licenseOk and isAllowedDisplayTf'), `${label}: missing setupLong fire gate`);
  assert(g.script.includes('canonSignalTuple'), `${label}: missing canonSignalTuple engine`);
  assert(g.script.includes('CANONICAL_SIGNAL_TF'), `${label}: missing CANONICAL_SIGNAL_TF`);
  assert(g.script.includes('request.security_lower_tf'), `${label}: missing event-safe security_lower_tf bridge`);
  assert(g.script.includes('useLowerTfBridge'), `${label}: missing useLowerTfBridge`);
  assert(
    /^indicator\([^;\n]*overlay\s*=\s*true\s*,\s*dynamic_requests\s*=\s*true/m.test(g.script),
    `${label}: indicator() must set dynamic_requests=true immediately after overlay=true`
  );
  assert(!/dynamic_requests\s*=\s*false/.test(g.script), `${label}: must not set dynamic_requests=false`);
  assert(g.script.includes('tradeCanonMeta'), `${label}: missing canonical lifecycle meta`);
  // Regression: comment-embedded {{EVENT_BRIDGE}} duplicated the bridge and left a stray ").".
  {
    const bridgeHeaders = (g.script.match(/OPTION A — EVENT-SAFE CANONICAL BRIDGE/g) || []).length;
    assert(bridgeHeaders === 1, `${label}: EVENT_BRIDGE must appear exactly once (got ${bridgeHeaders})`);
    const bridgeCounts = (g.script.match(/^bridgeEventCount = array\.size\(evSignalTime\)$/gm) || [])
      .length;
    assert(bridgeCounts === 1, `${label}: bridgeEventCount decl must appear once (got ${bridgeCounts})`);
    assert(
      !/bridgeEventCount = array\.size\(evSignalTime\)\s*\n\)\./.test(g.script),
      `${label}: stray ").\" after bridgeEventCount (comment placeholder injection)`
    );
    const dangling = g.script.split(/\r?\n/).filter((line) => /^\s*\)\.\s*$/.test(line) || /^\s*b\.\s*$/.test(line));
    assert(dangling.length === 0, `${label}: dangling token lines: ${JSON.stringify(dangling)}`);
    assert(!/\{\{[A-Z0-9_]+\}\}/.test(g.script), `${label}: unresolved {{PLACEHOLDER}} tokens remain`);
    {
      const codeOnly = g.script
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      assert(
        !/array\.size\([^)]+\)\s*>\s*0\s+and\s+array\.get\([^,]+,\s*array\.size\([^)]+\)\s*-\s*1\)/.test(
          codeOnly
        ),
        `${label}: unsafe array.get(size-1) behind non-short-circuit and (R10045)`
      );
    }
    assert(
      /lastEvDir\s*=\s*array\.size\(evDir\)\s*>\s*0\s*\?\s*array\.get\(evDir,\s*array\.size\(evDir\)\s*-\s*1\)\s*:\s*na/.test(
        g.script
      ),
      `${label}: missing ternary-safe lastEvDir`
    );
  }
  assert(g.script.includes('isAllowedDisplayTf'), `${label}: missing isAllowedDisplayTf`);
  assert(g.script.includes('isCanonicalChart'), `${label}: missing isCanonicalChart`);
  assert(g.script.includes('"chartTf":'), `${label}: missing chartTf in payload`);
  assert(g.script.includes('"canonicalSignalTf":'), `${label}: missing canonicalSignalTf in payload`);
  assert(g.script.includes('"canonicalSignalKey":'), `${label}: missing canonicalSignalKey in payload`);
  assert(!/fireLong\s*=\s*licenseOk and entryTfOk/.test(g.script), `${label}: fireLong must not hard-gate on entryTfOk`);
  assert(!/fireShort\s*=\s*licenseOk and entryTfOk/.test(g.script), `${label}: fireShort must not hard-gate on entryTfOk`);
  assert(g.script.includes('DEBUG_MODE'), `${label}: missing DEBUG_MODE input`);
  assert(g.script.includes('pineAlertBlockReason'), `${label}: missing pineAlertBlockReason diagnostics`);
  assert(g.script.includes('[PIPELINE] ALERT FIRING'), `${label}: missing ALERT FIRING debug log`);
  assert(g.script.includes('[PIPELINE] DRAWING CREATED'), `${label}: missing DRAWING CREATED debug log`);
  assert(g.script.includes('[PIPELINE] ALERT NOT FIRED'), `${label}: missing ALERT NOT FIRED debug log`);
  assert(g.script.includes('[PIPELINE] DEBUG STATE'), `${label}: missing DEBUG STATE log`);
  assert(g.script.includes('fireLong='), `${label}: missing fireLong state dump`);
  assert(g.script.includes('confirmedSignal'), `${label}: missing confirmedSignal`);
  assert(g.script.includes('bridgeEventCount'), `${label}: missing bridgeEventCount`);
  assert(g.script.includes('entryTfOk='), `${label}: missing entryTfOk state dump`);
  assert(g.script.includes('entryTfPreferred'), `${label}: missing entryTfPreferred advisory flag`);
  assert(g.script.includes('tradingStyle'), `${label}: missing tradingStyle classification`);
  assert(g.script.includes('TIMEFRAME GATE'), `${label}: missing dedicated TIMEFRAME GATE block`);
  assert(g.script.includes('entryChartOk'), `${label}: missing entryChartOk`);
  assert(g.script.includes('htfTfOk'), `${label}: missing htfTfOk`);
  assert(g.script.includes('chartIsHtf'), `${label}: missing chartIsHtf`);
  assert(g.script.includes('barmerge.lookahead_off'), `${label}: request.security must use lookahead_off`);
  assert(!g.script.includes('lookahead_on'), `${label}: must not use lookahead_on`);
  assert(g.script.includes('barstate.isconfirmed'), `${label}: missing barstate.isconfirmed for hist/rt parity`);
  assert(g.script.includes('barstate.isrealtime'), `${label}: DEBUG STATE should still dump isrealtime`);
  assert(
    /setupLong\s*=\s*licenseOk and isAllowedDisplayTf and newCanonLong and barstate\.isconfirmed/.test(
      g.script
    ),
    `${label}: setupLong must gate on allowed display TF + canonical edge + isconfirmed`
  );
  assert(
    /setupShort\s*=\s*licenseOk and isAllowedDisplayTf and newCanonShort and barstate\.isconfirmed/.test(
      g.script
    ),
    `${label}: setupShort must gate on allowed display TF + canonical edge + isconfirmed`
  );
  // Option A wrong-TF: only unsupported / not entryChartOk (never chart!=canonical / HTF / chartIsHtf).
  assert(
    /tfMsg\s*=\s*not strategyCfgOk \? "[^"]+" : not entryChartOk \? "[^"]+" : ""/.test(g.script),
    `${label}: tfMsg must only lock on unsupported or wrong display TF`
  );
  assert(!/fireLong\s*=.*barstate\.isrealtime/.test(g.script), `${label}: fireLong must not require isrealtime`);
  assert(!/fireShort\s*=.*barstate\.isrealtime/.test(g.script), `${label}: fireShort must not require isrealtime`);
  assert(!/if fireLong and barstate\.isrealtime/.test(g.script), `${label}: arming must not require isrealtime`);
  assert(!/if fireShort and barstate\.isrealtime/.test(g.script), `${label}: arming must not require isrealtime`);
  // DRAWING CREATED must be followed by ALERT FIRING (entry arming); lifecycle alerts may appear earlier in the snippet.
  {
    const drawIdx = g.script.indexOf('[PIPELINE] DRAWING CREATED');
    assert(drawIdx >= 0, `${label}: missing DRAWING CREATED`);
    const alertAfterDraw = g.script.indexOf('[PIPELINE] ALERT FIRING', drawIdx);
    assert(alertAfterDraw > drawIdx, `${label}: DRAWING CREATED must be followed by ALERT FIRING`);
    const between = g.script.slice(drawIdx, alertAfterDraw);
    assert(!between.includes('alert('), `${label}: must not call alert() between DRAWING CREATED and ALERT FIRING logs`);
  }
  // Entry drawings only inside fireLong/fireShort — not on raw retrace setup flags.
  assert(
    !/if\s+retraceLong\s*\n[\s\S]{0,200}buildTradeDrawings/.test(g.script),
    `${label}: must not draw on retraceLong alone`
  );
  assert(
    !/if\s+retraceShort\s*\n[\s\S]{0,200}buildTradeDrawings/.test(g.script),
    `${label}: must not draw on retraceShort alone`
  );
  // isCanonicalChart uses timeframe.period == CANONICAL_SIGNAL_TF (identity only; not a fire gate).
  assert(
    /isCanonicalChart\s*=\s*timeframe\.period\s*==\s*CANONICAL_SIGNAL_TF/.test(g.script),
    `${label}: isCanonicalChart must compare chart period to CANONICAL_SIGNAL_TF`
  );
  assert(g.script.includes('max_labels_count=500'), `${label}: max_labels_count should be 500`);
  assert(g.script.includes('width=1'), `${label}: trade lines must be width=1 (thinnest)`);
  assert(g.script.includes('alert.freq_all'), `${label}: lifecycle alerts must use freq_all`);
  assert(g.script.includes('licenseToken'), `${label}: missing licenseToken auth`);
  assert(!g.script.includes('"secret":'), `${label}: must not embed global webhook secret in payload`);
  assert(!g.script.includes('WEBHOOK_SECRET = "'), `${label}: must not bake WEBHOOK_SECRET into Pine`);
  assert(
    g.script.includes('CONFIRM_TV_USERNAME = input.string("demo_trader"'),
    `${label}: CONFIRM_TV_USERNAME must be prefilled with licensed username`
  );
  assert(
    !g.script.includes('CONFIRM_TV_USERNAME = input.string(""'),
    `${label}: CONFIRM_TV_USERNAME must not default to empty`
  );
  assert(g.script.includes('LICENSED_TV_USERNAME = "demo_trader"'), `${label}: missing licensed TV username bake-in`);
  // Additive Pine client version metadata (new regenerations only).
  assert(g.script.includes('"pineClientVersion":"'), `${label}: missing pineClientVersion in buildPayload`);
  assert(g.script.includes('"scriptGenerationId":"'), `${label}: missing scriptGenerationId in buildPayload`);
  assert(g.script.includes('"generatedAt":"'), `${label}: missing generatedAt in buildPayload`);
  assert(
    g.script.includes(
      '"capabilities":["v1_payload","sl_risk_v1","replace_active_v1","json_esc_v1","canonical_tf_v1","event_bridge_v1"]'
    ),
    `${label}: capabilities must stamp current 1.2.1 set`
  );
  assert(g.pineClientVersion === '1.2.1', `${label}: generator pineClientVersion must be 1.2.1`);
  assert(
    Array.isArray(g.capabilities) &&
      g.capabilities.length === 6 &&
      g.capabilities[0] === 'v1_payload' &&
      g.capabilities.includes('sl_risk_v1') &&
      g.capabilities.includes('replace_active_v1') &&
      g.capabilities.includes('json_esc_v1') &&
      g.capabilities.includes('canonical_tf_v1') &&
      g.capabilities.includes('event_bridge_v1'),
    `${label}: capabilities list`
  );
  assert(g.scriptGenerationId && g.scriptGenerationId.length >= 8, `${label}: missing scriptGenerationId`);
  assert(!/\btradeActive\s*:=/.test(g.script), `${label}: must not use tradeActive :=`);
  assert(!/\bactiveEntry\s*:=/.test(g.script), `${label}: must not use activeEntry :=`);
  auditGlobalMutationInFunctions(g.script, label);
}

assert(day.script.includes('expiryBars = input.int(80'), 'daytrading default expiry should be 80');
assert(scalp.script.includes('expiryBars = input.int(60'), 'scalping default expiry should be 60');
assert(day.script.includes('enableTradeExpiry = input.bool(true'), 'daytrading missing enableTradeExpiry input');
assert(scalp.script.includes('enableTradeExpiry = input.bool(true'), 'scalping missing enableTradeExpiry input');

// Dedicated TF architecture checks (config-driven)
const {
  STRATEGY_ARCHITECTURE,
  buildPineTfVariables,
  validateAllStrategyArchitectures
} = require('../strategies/config/strategyArchitecture');

const archReport = validateAllStrategyArchitectures();
assert(archReport.ok, `strategy architecture invalid: ${archReport.errors.join('; ')}`);

assert(day.script.includes('STRATEGY_KEY = "daytrading"'), 'daytrading: missing STRATEGY_KEY');
assert(scalp.script.includes('STRATEGY_KEY = "scalping"'), 'scalping: missing STRATEGY_KEY');
assert(
  day.script.includes('timeframe.multiplier == 5 or timeframe.multiplier == 15'),
  'daytrading: entry charts must be 5m or 15m'
);
assert(
  scalp.script.includes(
    'timeframe.multiplier == 1 or timeframe.multiplier == 3 or timeframe.multiplier == 5'
  ),
  'scalping: entry charts must be 1m, 3m, or 5m'
);
assert(day.script.includes('htfSec == 3600 or htfSec == 14400'), 'daytrading: HTF must be 1H or 4H');
assert(scalp.script.includes('htfSec == 900'), 'scalping: HTF must be 15m');
assert(day.instructions[0].includes('5m or 15m'), 'daytrading instructions must mention 5m/15m entry');
assert(day.instructions[0].includes('Day Trading'), 'daytrading instructions must name Day Trading');
assert(
  /canonical|allowed display/i.test(day.instructions[0]),
  'daytrading instructions must describe Option A canonical/allowed display'
);
assert(scalp.instructions[0].includes('1m, 3m, or 5m'), 'scalping instructions must mention 1m/3m/5m display');
assert(scalp.instructions[0].includes('canonical 3m') || scalp.instructions[0].includes('canonical'), 'scalping instructions must mention canonical TF');
assert(scalp.instructions[0].includes('Day Trading'), 'scalping instructions must tip Day Trading for 15m profile');
assert(scalp.script.includes('Wrong Entry Timeframe (Scalping)'), 'scalping: wrong-entry label must name Scalping');
assert(day.script.includes('Wrong Entry Timeframe (Day Trading)'), 'daytrading: wrong-entry label must name Day Trading');

// Config-driven HTF + canonical bake-in + diagnostic labels
assert(scalp.strategyArchitecture.bakedHtfPine === '15', 'scalping: baked HTF must be 15 from Strategy Config');
assert(day.strategyArchitecture.bakedHtfPine === '60', 'daytrading: baked default HTF must be 60 (1h)');
assert(scalp.strategyArchitecture.canonicalSignalTimeframe === '3m', 'scalping: canonicalSignalTimeframe must be 3m');
assert(day.strategyArchitecture.canonicalSignalTimeframe === '5m', 'daytrading: canonicalSignalTimeframe must be 5m');
assert(scalp.strategyArchitecture.bakedCanonicalSignalPine === '3', 'scalping: baked canonical pine TF must be 3');
assert(day.strategyArchitecture.bakedCanonicalSignalPine === '5', 'daytrading: baked canonical pine TF must be 5');
assert(
  JSON.stringify(scalp.strategyArchitecture.entryTimeframes) ===
    JSON.stringify([...STRATEGY_ARCHITECTURE.scalping.entryTimeframes]),
  'scalping: generated entry TFs must match Strategy Architecture'
);
assert(
  JSON.stringify(day.strategyArchitecture.htfTimeframes) ===
    JSON.stringify([...STRATEGY_ARCHITECTURE.daytrading.htfTimeframes]),
  'daytrading: generated HTFs must match Strategy Architecture'
);
assert(STRATEGY_ARCHITECTURE.scalping.canonicalSignalTimeframe === '3m', 'architecture scalping canonical must be 3m');
assert(STRATEGY_ARCHITECTURE.daytrading.canonicalSignalTimeframe === '5m', 'architecture daytrading canonical must be 5m');
assert(scalp.script.includes('Wrong Entry Timeframe'), 'scalping: missing Wrong Entry Timeframe label');
assert(scalp.script.includes('Unsupported Strategy Configuration'), 'scalping: missing Unsupported Strategy label');
assert(scalp.script.includes('CANONICAL_SIGNAL_TF = "3"'), 'scalping: CANONICAL_SIGNAL_TF must bake 3');
assert(day.script.includes('CANONICAL_SIGNAL_TF = "5"'), 'daytrading: CANONICAL_SIGNAL_TF must bake 5');
assert(day.script.includes('htfConfigured'), 'daytrading: missing htfConfigured');
assert(scalp.script.includes('strategyCfgOk'), 'scalping: missing strategyCfgOk');
assert(scalp.script.includes('wrong_display_tf'), 'scalping: pineAlertBlockReason should mention wrong_display_tf');
assert(day.script.includes('wrong_display_tf'), 'daytrading: pineAlertBlockReason should mention wrong_display_tf');

const scalpVars = buildPineTfVariables('scalping');
assert(scalpVars.CANONICAL_SIGNAL_TF === '3', 'scalping buildPineTfVariables CANONICAL_SIGNAL_TF');
assert(scalpVars.ARCH_CANONICAL_SIGNAL_TF === '3m', 'scalping ARCH_CANONICAL_SIGNAL_TF');
assert(scalp.script.includes(scalpVars.ENTRY_CHART_OK), 'scalping: ENTRY_CHART_OK from config must appear in script');
assert(scalp.script.includes(`input.timeframe("${scalpVars.HTF_TF}"`), 'scalping: HTF input default must match config');
assert(scalp.script.includes(`CANONICAL_SIGNAL_TF = "${scalpVars.CANONICAL_SIGNAL_TF}"`), 'scalping: canonical TF from config');

const dayVars = buildPineTfVariables('daytrading');
assert(dayVars.CANONICAL_SIGNAL_TF === '5', 'daytrading buildPineTfVariables CANONICAL_SIGNAL_TF');
assert(dayVars.ARCH_CANONICAL_SIGNAL_TF === '5m', 'daytrading ARCH_CANONICAL_SIGNAL_TF');

// Scalping entry allowlist includes pre-Aug-3 1m charts (regression restore).
assert(STRATEGY_ARCHITECTURE.scalping.entryTimeframes.includes('1m'), 'architecture must list 1m scalping');
assert(/multiplier == 1\b/.test(scalp.script), 'scalping generated Pine must allow 1m multiplier');

console.log(
  JSON.stringify(
    {
      ok: true,
      pineGlobalMutationAudit: 'passed',
      tfValidationArchitecture: 'passed',
      strategyArchitectureDriven: 'passed',
      violations: 0,
      daytrading: {
        hasPersistence: true,
        expiryDefault: 80,
        enableTradeExpiry: true,
        compileSafeDrawingEngine: true,
        entryCharts: day.strategyArchitecture.entryTimeframes,
        htf: day.strategyArchitecture.htfTimeframes,
        bakedHtfPine: day.strategyArchitecture.bakedHtfPine,
        webhookUrl: day.webhookUrl
      },
      scalping: {
        hasPersistence: true,
        expiryDefault: 60,
        enableTradeExpiry: true,
        compileSafeDrawingEngine: true,
        entryCharts: scalp.strategyArchitecture.entryTimeframes,
        htf: scalp.strategyArchitecture.htfTimeframes,
        bakedHtfPine: scalp.strategyArchitecture.bakedHtfPine,
        webhookUrl: scalp.webhookUrl
      }
    },
    null,
    2
  )
);
