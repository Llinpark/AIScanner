import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_SCANNER_SYMBOLS,
  normalizeMarketSymbol,
  normalizeTradingViewSymbol,
  isSupportedScannerSymbol,
  alertMatchesSymbol
} from '../markets.js';

describe('frontend markets (no hard allowlist)', () => {
  it('lists preferred Admin defaults', () => {
    assert.equal(SUPPORTED_SCANNER_SYMBOLS.length, 8);
    assert.ok(SUPPORTED_SCANNER_SYMBOLS.includes('EUR/USD'));
    assert.ok(SUPPORTED_SCANNER_SYMBOLS.includes('US100'));
  });

  it('accepts any TradingView instrument', () => {
    assert.equal(normalizeMarketSymbol('FX:EURUSD'), 'EUR/USD');
    assert.equal(normalizeMarketSymbol('TVC:DJI'), 'US30');
    assert.equal(isSupportedScannerSymbol('XAUUSD'), true);
    assert.equal(isSupportedScannerSymbol('JUMP 10'), true);
    assert.equal(isSupportedScannerSymbol('Volatility 75'), true);
    assert.equal(isSupportedScannerSymbol('BTCUSD'), true);
    assert.equal(isSupportedScannerSymbol(''), false);
  });

  it('normalizes broker/TV formats without blocking', () => {
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
      ['BTCUSD', 'BTCUSD']
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeTradingViewSymbol(input), expected, input);
      assert.equal(isSupportedScannerSymbol(input), true, input);
    }
  });

  it('matches alerts by normalized symbol', () => {
    assert.equal(alertMatchesSymbol({ symbol: 'EURUSD' }, 'EUR/USD'), true);
    assert.equal(alertMatchesSymbol({ symbol: 'GBPUSD' }, 'EUR/USD'), false);
    assert.equal(alertMatchesSymbol({ symbol: 'EURUSD' }, 'ALL'), true);
    assert.equal(alertMatchesSymbol({ symbol: 'XAUUSD.i' }, 'XAU/USD'), true);
    assert.equal(alertMatchesSymbol({ symbol: 'BTCUSD' }, 'BTCUSD'), true);
  });
});
