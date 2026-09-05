const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  decimalsFromMintick,
  inferMintickFromPrice,
  formatTvPrice
} = require('../priceFormat');

describe('universal mintick price formatting', () => {
  it('derives decimals from mintick', () => {
    assert.equal(decimalsFromMintick(1), 0);
    assert.equal(decimalsFromMintick(0.1), 1);
    assert.equal(decimalsFromMintick(0.01), 2);
    assert.equal(decimalsFromMintick(0.001), 3);
    assert.equal(decimalsFromMintick(0.00001), 5);
  });

  it('formats common instruments via inferred step (no symbol table)', () => {
    // EURUSD-like (~1.08)
    assert.equal(formatTvPrice(1.08542), '1.08542');
    // USDJPY-like (~149) → inferred 0.01
    assert.equal(formatTvPrice(149.523), '149.52');
    // XAUUSD-like
    assert.equal(formatTvPrice(2650.45), '2650.45');
    // BTCUSD-like
    assert.equal(formatTvPrice(64012.34), '64012.34');
    // US30 / NAS100-like
    assert.equal(formatTvPrice(39100.5), '39100.50');
    // Deriv synthetic-like mid price
    assert.equal(formatTvPrice(1234.567), '1234.57');
  });

  it('honors explicit mintick over inference', () => {
    assert.equal(formatTvPrice(1.08542321, 0.00001), '1.08542');
    assert.equal(formatTvPrice(39100.567, 1), '39101');
    assert.equal(formatTvPrice(2650.456, 0.01), '2650.46');
    assert.equal(formatTvPrice(149.523, 0.001), '149.523');
  });

  it('ignores symbol strings and still formats from price', () => {
    assert.equal(formatTvPrice(149.52, 'USDJPY'), '149.52');
    assert.equal(inferMintickFromPrice(149.52), 0.01);
    assert.equal(inferMintickFromPrice(1.085), 1e-5);
  });
});
