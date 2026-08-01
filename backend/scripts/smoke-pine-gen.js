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
  assert(g.script.includes('not tradeIsActive()'), `${label}: missing active-trade entry gate`);
  assert(g.script.includes('expiryBars'), `${label}: missing expiryBars`);
  assert(g.script.includes('enableTradeExpiry'), `${label}: missing enableTradeExpiry`);
  assert(g.script.includes('buildTradeDrawings'), `${label}: missing pure buildTradeDrawings`);
  assert(g.script.includes('makeSignalId'), `${label}: missing permanent signal id`);
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
  assert(g.script.includes('licenseOk and entryTfOk'), `${label}: missing license+entryTf fire gate`);
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
  assert(!/\btradeActive\s*:=/.test(g.script), `${label}: must not use tradeActive :=`);
  assert(!/\bactiveEntry\s*:=/.test(g.script), `${label}: must not use activeEntry :=`);
  auditGlobalMutationInFunctions(g.script, label);
}

assert(day.script.includes('expiryBars = input.int(80'), 'daytrading default expiry should be 80');
assert(scalp.script.includes('expiryBars = input.int(60'), 'scalping default expiry should be 60');
assert(day.script.includes('enableTradeExpiry = input.bool(true'), 'daytrading missing enableTradeExpiry input');
assert(scalp.script.includes('enableTradeExpiry = input.bool(true'), 'scalping missing enableTradeExpiry input');

console.log(
  JSON.stringify(
    {
      ok: true,
      pineGlobalMutationAudit: 'passed',
      violations: 0,
      daytrading: {
        hasPersistence: true,
        expiryDefault: 80,
        enableTradeExpiry: true,
        compileSafeDrawingEngine: true,
        webhookUrl: day.webhookUrl
      },
      scalping: {
        hasPersistence: true,
        expiryDefault: 60,
        enableTradeExpiry: true,
        compileSafeDrawingEngine: true,
        webhookUrl: scalp.webhookUrl
      }
    },
    null,
    2
  )
);
