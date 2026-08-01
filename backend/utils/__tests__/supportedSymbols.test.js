const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALL_CURRENCY_PAIRS,
  SUPPORTED_COMPACT_SYMBOLS,
  normalizeSymbol,
  isSupportedScannerSymbol,
  toCompactSymbol
} = require('../../config/symbols');

describe('supported scanner symbol invariant', () => {
  it('exposes exactly the eight Admin-supported assets', () => {
    assert.deepEqual(ALL_CURRENCY_PAIRS, [
      'EUR/USD',
      'GBP/USD',
      'USD/JPY',
      'AUD/USD',
      'USD/CAD',
      'XAU/USD',
      'US30',
      'US100'
    ]);
    assert.deepEqual(SUPPORTED_COMPACT_SYMBOLS, [
      'EURUSD',
      'GBPUSD',
      'USDJPY',
      'AUDUSD',
      'USDCAD',
      'XAUUSD',
      'US30',
      'US100'
    ]);
  });

  it('accepts supported aliases and rejects Deriv/Jump/Volatility/crypto', () => {
    assert.equal(isSupportedScannerSymbol('FX:EURUSD'), true);
    assert.equal(isSupportedScannerSymbol('EURUSD'), true);
    assert.equal(isSupportedScannerSymbol('TVC:DJI'), true);
    assert.equal(normalizeSymbol('TVC:DJI'), 'US30');
    assert.equal(toCompactSymbol('NAS100'), 'US100');

    assert.equal(isSupportedScannerSymbol('JUMP 10'), false);
    assert.equal(isSupportedScannerSymbol('Jump 75'), false);
    assert.equal(isSupportedScannerSymbol('Volatility 75'), false);
    assert.equal(isSupportedScannerSymbol('R_75'), false);
    assert.equal(isSupportedScannerSymbol('Deriv'), false);
    assert.equal(isSupportedScannerSymbol('BTC/USD'), false);
    assert.equal(isSupportedScannerSymbol('XAG/USD'), false);
    assert.equal(isSupportedScannerSymbol('NZD/USD'), false);
  });
});
