/**
 * Regression: lifecycle systems must NOT depend on entryTfOk / preferred chart TF.
 * After Aug 2026 TF hard-gate → advisory refactor, expiry / duplicate suppression /
 * active-trade tracking / TP / SL must still work on non-preferred TFs (30m, 1H).
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ActiveSignalRegistry = require('../activeSignalRegistry');
const TradeLifecycleService = require('../../services/TradeLifecycleService');
const {
  enrichEntrySignal,
  applyOutcomeUpdate,
  computeExpiresAt,
  timeframeToMs
} = require('../signalOutcome');

const SNIPPET = fs.readFileSync(
  path.join(__dirname, '../../templates/snippets/kaching-trade-drawing.pine.snippet'),
  'utf8'
);
const ARM_SNIPPET = fs.readFileSync(
  path.join(__dirname, '../../templates/snippets/kaching-canon-event-arm.pine.snippet'),
  'utf8'
);
const BRIDGE_SNIPPET = fs.readFileSync(
  path.join(__dirname, '../../templates/snippets/kaching-canon-event-bridge.pine.snippet'),
  'utf8'
);
const SCALP_TPL = fs.readFileSync(
  path.join(__dirname, '../../templates/kaching-sweep-fvg-scalp.pine.template'),
  'utf8'
);
const DAY_TPL = fs.readFileSync(
  path.join(__dirname, '../../templates/kaching-sweep-fvg-daytrading.pine.template'),
  'utf8'
);

function baseEntry(overrides = {}) {
  return {
    symbol: 'EURUSD',
    direction: 'long',
    entry: 1.1,
    stop_loss: 1.09,
    take_profit_1: 1.11,
    take_profit_2: 1.12,
    take_profit_3: 1.13,
    alertType: 'entry',
    strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    expiryBars: 60,
    enableTradeExpiry: true,
    ...overrides
  };
}

describe('lifecycle TF-independence (post entryTfOk advisory refactor)', () => {
  beforeEach(() => {
    ActiveSignalRegistry.resetForTests();
  });

  it('expiry attaches expiresAt on non-preferred TFs (30m / 1H) without entryTfOk', () => {
    const from = new Date('2026-08-07T12:00:00.000Z');
    const exp30 = computeExpiresAt('30m', 60, from);
    const exp1h = computeExpiresAt('1h', 80, from);
    assert.ok(exp30);
    assert.ok(exp1h);
    assert.equal(exp30.getTime(), from.getTime() + 60 * timeframeToMs('30m'));
    assert.equal(exp1h.getTime(), from.getTime() + 80 * timeframeToMs('1h'));

    const attached30 = TradeLifecycleService.attachExpiryFields(
      baseEntry({ timeframe: '30', expiryBars: 60 })
    );
    const attached1h = TradeLifecycleService.attachExpiryFields(
      baseEntry({ timeframe: '60', expiryBars: 80 })
    );
    assert.equal(attached30.expiryBars, 60);
    assert.equal(attached30.enableTradeExpiry, true);
    assert.ok(attached30.expiresAt instanceof Date);
    assert.equal(attached1h.expiryBars, 80);
    assert.ok(attached1h.expiresAt instanceof Date);

    const enriched = enrichEntrySignal(baseEntry({ timeframe: '30m', signalUuid: 'tf-ind-exp' }));
    assert.equal(enriched.timeframe, '30m');
    assert.equal(enriched.expiryBars, 60);
    assert.ok(enriched.expiresAt);
  });

  it('active-trade tracking + duplicate suppression work on 30m (entryTfOk would be false)', async () => {
    const first = enrichEntrySignal(
      baseEntry({ timeframe: '30m', signalUuid: 'tf-ind-30-a' })
    );
    await ActiveSignalRegistry.registerActive(first);
    assert.equal(await ActiveSignalRegistry.hasActive('EURUSD', '30m'), true);

    const differentUuid = await TradeLifecycleService.assertCanOpenEntry({
      symbol: 'EURUSD',
      timeframe: '30m',
      alertType: 'entry',
      signalUuid: 'tf-ind-30-b',
      strategyName: first.strategyName
    });
    assert.equal(differentUuid.allowed, true);
    assert.equal(differentUuid.reason, 'replaced_active_trade');
    assert.equal(differentUuid.replaced, true);

    // Replacement clears the prior slot; register the new setup, then replay its UUID.
    const replacement = enrichEntrySignal(
      baseEntry({ timeframe: '30m', signalUuid: 'tf-ind-30-b' })
    );
    await ActiveSignalRegistry.registerActive(replacement);

    const sameUuid = await TradeLifecycleService.assertCanOpenEntry({
      symbol: 'EURUSD',
      timeframe: '30m',
      alertType: 'entry',
      signalUuid: 'tf-ind-30-b',
      strategyName: first.strategyName
    });
    assert.equal(sameUuid.allowed, false);
    assert.equal(sameUuid.reason, 'duplicate_webhook_replay');
  });

  it('TP lifecycle (TP1→TP2→TP3) and SL lifecycle work on 1H without preferred-TF gate', async () => {
    const tpPath = enrichEntrySignal(
      baseEntry({ timeframe: '1h', signalUuid: 'tf-ind-1h-tp' })
    );
    await ActiveSignalRegistry.registerActive(tpPath);
    applyOutcomeUpdate(tpPath, 'take_profit_1');
    assert.equal(tpPath.lifecycleStage, 'TP1');
    assert.equal(tpPath.tradeStatus, 'partial');
    await ActiveSignalRegistry.updateActiveStage(
      { symbol: 'EURUSD', timeframe: '1h' },
      'TP1',
      { signalUuid: 'tf-ind-1h-tp' }
    );
    applyOutcomeUpdate(tpPath, 'take_profit_2');
    assert.equal(tpPath.lifecycleStage, 'TP2');
    applyOutcomeUpdate(tpPath, 'take_profit_3');
    assert.equal(tpPath.lifecycleStage, 'TP3');
    assert.ok(tpPath.closedAt);
    await ActiveSignalRegistry.clearActive({ symbol: 'EURUSD', timeframe: '1h' }, 'tp3');
    assert.equal(await ActiveSignalRegistry.hasActive('EURUSD', '1h'), false);

    const slPath = enrichEntrySignal(
      baseEntry({
        timeframe: '60',
        signalUuid: 'tf-ind-1h-sl',
        direction: 'short',
        entry: 1.2,
        stop_loss: 1.21,
        take_profit_1: 1.19,
        take_profit_2: 1.18,
        take_profit_3: 1.17
      })
    );
    await ActiveSignalRegistry.registerActive(slPath);
    applyOutcomeUpdate(slPath, 'stop_loss');
    assert.equal(slPath.lifecycleStage, 'SL');
    assert.equal(slPath.tradeStatus, 'lost');
    await ActiveSignalRegistry.clearActive({ symbol: 'EURUSD', timeframe: '1h' }, 'sl');
    assert.equal(await ActiveSignalRegistry.hasActive('EURUSD', '1h'), false);
  });

  it('expiry outcome closes active registry slot on non-preferred TF', async () => {
    const entry = enrichEntrySignal(
      baseEntry({ timeframe: '30m', signalUuid: 'tf-ind-exp-close', expiryBars: 10 })
    );
    await ActiveSignalRegistry.registerActive(entry);
    applyOutcomeUpdate(entry, 'expired', 'candle_expiry');
    assert.equal(entry.lifecycleStage, 'EXPIRED');
    assert.equal(entry.tradeStatus, 'expired');
    await ActiveSignalRegistry.clearActive({ symbol: 'EURUSD', timeframe: '30m' }, 'expired');
    assert.equal(await ActiveSignalRegistry.hasActive('EURUSD', '30m'), false);
  });

  it('Pine drawing/arm lifecycle has no entryTfOk / preferred-TF hard gate', () => {
    assert.match(SNIPPET, /tradeIsActive\(\)\s*=>/);
    assert.match(SNIPPET, /tradeCanonMeta/);
    assert.match(ARM_SNIPPET, /expired = enableTradeExpiry and barsAlive >= expiryBars/);
    assert.match(ARM_SNIPPET, /closeAlertType = hitSl \? "stop_loss"/);
    assert.match(ARM_SNIPPET, /take_profit_1/);
    assert.match(ARM_SNIPPET, /take_profit_2/);
    assert.match(ARM_SNIPPET, /canonLifeHigh|lifeH/);
    assert.match(BRIDGE_SNIPPET, /request\.security_lower_tf/);
    assert.doesNotMatch(SNIPPET, /entryTfOk/);
    assert.doesNotMatch(SNIPPET, /entryTfPreferred/);
    assert.doesNotMatch(SNIPPET, /entryChartOk/);
    assert.doesNotMatch(SNIPPET, /htfTfOk/);
  });

  it('Pine templates arm via event bridge without entryTfOk', () => {
    for (const [label, tpl] of [
      ['scalp', SCALP_TPL],
      ['day', DAY_TPL]
    ]) {
      assert.match(tpl, /\{\{EVENT_BRIDGE\}\}/, `${label}: missing EVENT_BRIDGE slot`);
      assert.match(tpl, /\{\{EVENT_ARM\}\}/, `${label}: missing EVENT_ARM slot`);
      assert.match(tpl, /canonSignalTuple/, `${label}: missing canonSignalTuple`);
      assert.match(tpl, /resolveValidStop/, `${label}: missing resolveValidStop`);
      assert.doesNotMatch(tpl, /fireLong\s*=\s*.*entryTfOk/, `${label}: fireLong must not AND entryTfOk`);
      assert.doesNotMatch(tpl, /fireShort\s*=\s*.*entryTfOk/, `${label}: fireShort must not AND entryTfOk`);
      assert.doesNotMatch(tpl, /wrong_entry_tf/, `${label}: no wrong_entry_tf blocker`);
    }
    assert.match(
      ARM_SNIPPET,
      /setupLong = licenseOk and isAllowedDisplayTf and newCanonLong and barstate\.isconfirmed/
    );
    assert.match(
      ARM_SNIPPET,
      /setupShort = licenseOk and isAllowedDisplayTf and newCanonShort and barstate\.isconfirmed/
    );
    assert.match(ARM_SNIPPET, /new_confirmed_setup/);
    assert.match(ARM_SNIPPET, /array\.set\(tradeFlags, 0, 1\)/);
    const blockStart = ARM_SNIPPET.indexOf('pineAlertBlockReason(bool tradeActiveNow)');
    assert.ok(blockStart >= 0, 'pineAlertBlockReason function missing');
    const lines = ARM_SNIPPET.slice(blockStart).split(/\r?\n/);
    const bodyLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0) {
        bodyLines.push(line);
        continue;
      }
      if (line.trim() === '') break;
      if (/^[^\s/]/.test(line)) break;
      bodyLines.push(line);
    }
    const blockBody = bodyLines.join('\n');
    assert.match(blockBody, /"will_replace_active"/);
    assert.match(blockBody, /"license"/);
    assert.doesNotMatch(blockBody, /entryTfOk|entryTfPreferred|entryChartOk|htfTfOk|wrong_entry/);
  });
});
