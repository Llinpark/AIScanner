const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALL_CURRENCY_PAIRS,
  SUPPORTED_COMPACT_SYMBOLS,
  normalizeSymbol,
  normalizeTradingViewSymbol,
  isSupportedScannerSymbol,
  toCompactSymbol
} = require('../../config/symbols');

describe('preferred scanner symbol catalog (not a hard allowlist)', () => {
  it('exposes preferred Admin defaults', () => {
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

  it('accepts any TradingView instrument (no hard reject list)', () => {
    assert.equal(isSupportedScannerSymbol('FX:EURUSD'), true);
    assert.equal(isSupportedScannerSymbol('EURUSD'), true);
    assert.equal(isSupportedScannerSymbol('TVC:DJI'), true);
    assert.equal(normalizeSymbol('TVC:DJI'), 'US30');
    assert.equal(toCompactSymbol('NAS100'), 'US100');

    assert.equal(isSupportedScannerSymbol('JUMP 10'), true);
    assert.equal(isSupportedScannerSymbol('Jump 75'), true);
    assert.equal(isSupportedScannerSymbol('Volatility 75'), true);
    assert.equal(isSupportedScannerSymbol('BTCUSD'), true);
    assert.equal(isSupportedScannerSymbol('XAGUSD'), true);
    assert.equal(isSupportedScannerSymbol('NZDUSD'), true);
    assert.equal(isSupportedScannerSymbol(''), false);
  });

  it('normalizes broker/TV formats without blocking unknown instruments', () => {
    const cases = [
      ['OANDA:EURUSD', 'EURUSD'],
      ['FOREXCOM:EURUSD', 'EURUSD'],
      ['FX:EURUSD', 'EURUSD'],
      ['EURUSD', 'EURUSD'],
      ['EURUSD.i', 'EURUSD'],
      ['EURUSDm', 'EURUSD'],
      ['EURUSD.pro', 'EURUSD'],
      ['OANDA:XAUUSD', 'XAUUSD'],
      ['XAUUSD', 'XAUUSD'],
      ['XAUUSD.i', 'XAUUSD'],
      ['US30.cash', 'US30'],
      ['US30', 'US30'],
      ['US100.cash', 'US100'],
      ['US100', 'US100'],
      ['NAS100', 'US100'],
      ['TVC:DJI', 'US30'],
      ['BTCUSD', 'BTCUSD'],
      ['Volatility75', 'VOLATILITY75']
    ];

    for (const [input, expected] of cases) {
      assert.equal(
        normalizeTradingViewSymbol(input),
        expected,
        `normalizeTradingViewSymbol(${input})`
      );
      assert.equal(isSupportedScannerSymbol(input), true, `isSupportedScannerSymbol(${input})`);
    }
  });
});
