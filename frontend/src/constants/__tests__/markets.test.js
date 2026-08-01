import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_SCANNER_SYMBOLS,
  normalizeMarketSymbol,
  isSupportedScannerSymbol,
  alertMatchesSymbol
} from '../markets.js';

describe('frontend markets allowlist', () => {
  it('lists exactly eight supported assets', () => {
    assert.equal(SUPPORTED_SCANNER_SYMBOLS.length, 8);
    assert.ok(SUPPORTED_SCANNER_SYMBOLS.includes('EUR/USD'));
    assert.ok(SUPPORTED_SCANNER_SYMBOLS.includes('US100'));
  });

  it('normalizes aliases and rejects unsupported instruments', () => {
    assert.equal(normalizeMarketSymbol('FX:EURUSD'), 'EUR/USD');
    assert.equal(normalizeMarketSymbol('TVC:DJI'), 'US30');
    assert.equal(isSupportedScannerSymbol('XAUUSD'), true);
    assert.equal(isSupportedScannerSymbol('JUMP 10'), false);
    assert.equal(isSupportedScannerSymbol('Volatility 75'), false);
    assert.equal(isSupportedScannerSymbol('BTCUSD'), false);
    assert.equal(isSupportedScannerSymbol('Deriv'), false);
  });

  it('matches alerts by normalized symbol', () => {
    assert.equal(alertMatchesSymbol({ symbol: 'EURUSD' }, 'EUR/USD'), true);
    assert.equal(alertMatchesSymbol({ symbol: 'GBPUSD' }, 'EUR/USD'), false);
    assert.equal(alertMatchesSymbol({ symbol: 'EURUSD' }, 'ALL'), true);
  });
});
