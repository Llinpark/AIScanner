const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getSymbolAssetClass } = require('../../config/symbols');
const {
  DEFAULT_MAX_SPREAD_PIPS_BY_CLASS,
  resolveMaxSpreadPips
} = require('../maxSpreadLimits');

describe('maxSpreadLimits', () => {
  it('uses class defaults Forex 2.5 / Gold 5 / Indices 10', () => {
    assert.equal(DEFAULT_MAX_SPREAD_PIPS_BY_CLASS.forex, 2.5);
    assert.equal(DEFAULT_MAX_SPREAD_PIPS_BY_CLASS.gold, 5);
    assert.equal(DEFAULT_MAX_SPREAD_PIPS_BY_CLASS.indices, 10);
  });

  it('classifies symbols into forex, gold, and indices', () => {
    assert.equal(getSymbolAssetClass('EUR/USD'), 'forex');
    assert.equal(getSymbolAssetClass('XAUUSD'), 'gold');
    assert.equal(getSymbolAssetClass('US30'), 'indices');
    assert.equal(getSymbolAssetClass('NAS100'), 'indices');
  });

  it('resolves spread limits by asset class', () => {
    assert.equal(resolveMaxSpreadPips('EURUSD'), 2.5);
    assert.equal(resolveMaxSpreadPips('XAU/USD'), 5);
    assert.equal(resolveMaxSpreadPips('US100'), 10);
  });

  it('allows admin class overrides', () => {
    assert.equal(
      resolveMaxSpreadPips('GBP/USD', { maxSpreadPipsByClass: { forex: 1.8 } }),
      1.8
    );
    assert.equal(
      resolveMaxSpreadPips('XAU/USD', { maxSpreadPipsByClass: { gold: 6.5 } }),
      6.5
    );
  });

  it('prefers per-symbol overrides over class defaults', () => {
    assert.equal(
      resolveMaxSpreadPips('EUR/USD', {
        maxSpreadPipsByClass: { forex: 2.5 },
        maxSpreadPipsBySymbol: { 'EUR/USD': 1.2 }
      }),
      1.2
    );
  });

  it('ignores legacy global maxSpreadPips when resolving by class', () => {
    assert.equal(
      resolveMaxSpreadPips('EUR/USD', { maxSpreadPips: 25 }),
      2.5
    );
  });
});
