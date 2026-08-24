const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSignalLevels,
  validateKachingEntrySignal
} = require('../kachingSignalLevels');

describe('normalizeSignalLevels — never invent prices', () => {
  it('passes through TradingView levels only', () => {
    const levels = normalizeSignalLevels({
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.11,
      take_profit_2: 1.12,
      take_profit_3: 1.13
    });
    assert.equal(levels.entry, 1.1);
    assert.equal(levels.stop_loss, 1.09);
    assert.equal(levels.take_profit_3, 1.13);
  });

  it('aliases camelCase / tpN / stopLoss fields without inventing prices', () => {
    const levels = normalizeSignalLevels({
      entry: 1.1754,
      stopLoss: 1.1745,
      takeProfit1: 1.1762,
      takeProfit2: 1.177,
      tp3: 1.1782
    });
    assert.equal(levels.stop_loss, 1.1745);
    assert.equal(levels.take_profit_1, 1.1762);
    assert.equal(levels.take_profit_2, 1.177);
    assert.equal(levels.take_profit_3, 1.1782);
  });

  it('does not invent SL/TP when missing', () => {
    const levels = normalizeSignalLevels({ entry: 100, direction: 'long' });
    assert.equal(levels.entry, 100);
    assert.equal(levels.stop_loss, undefined);
    assert.equal(levels.take_profit_1, undefined);
  });

  it('rejects incomplete entry webhooks', () => {
    assert.throws(
      () =>
        validateKachingEntrySignal({
          alertType: 'entry',
          entry: 1.1,
          stop_loss: 1.09
        }),
      /never invented/i
    );
  });
});
