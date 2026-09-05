const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isSyntheticSymbol,
  resolveValidStop,
  validateMinRr,
  escapeJsonString
} = require('../kachingSlRisk');

describe('kachingSlRisk', () => {
  it('detects JUMP / synthetic symbols', () => {
    assert.equal(isSyntheticSymbol('JUMP_50_INDEX'), true);
    assert.equal(isSyntheticSymbol('Boom 1000 Index'), true);
    assert.equal(isSyntheticSymbol('XAUUSD'), false);
    assert.equal(isSyntheticSymbol('EURUSD'), false);
  });

  it('TEST 1 — far structural SL is rejected when no fallback', () => {
    const r = resolveValidStop({
      direction: 'short',
      entry: 53580,
      sweepExtreme: 54919,
      fvgTop: 56000,
      fvgBot: 55900,
      atr: 200,
      bufferAtrRatio: 0.05,
      maxStopAtrMult: 1.5,
      stopModel: 'sweep',
      symbol: 'EURUSD'
    });
    // max = 300; sweep dist ~1339; fvg even farther → reject
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'SIGNAL_REJECTED_SL_TOO_FAR');
  });

  it('TEST 2 — FVG fallback selected when sweep too far (JUMP)', () => {
    const r = resolveValidStop({
      direction: 'short',
      entry: 53580,
      sweepExtreme: 54919,
      fvgTop: 53680,
      fvgBot: 53620,
      atr: 200,
      bufferAtrRatio: 0.05,
      maxStopAtrMult: 1.5,
      stopModel: 'sweep',
      symbol: 'JUMP_50_INDEX'
    });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'fvg');
    assert.ok(r.distance <= 200 * 1.5);
    assert.ok(r.sl > 53580);
  });

  it('TEST 3 — no valid SL rejects', () => {
    const r = resolveValidStop({
      direction: 'long',
      entry: 100,
      sweepExtreme: 50,
      fvgTop: 40,
      fvgBot: 30,
      atr: 2,
      bufferAtrRatio: 0.05,
      maxStopAtrMult: 1.5,
      stopModel: 'sweep',
      symbol: 'JUMP_10'
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'SIGNAL_REJECTED_SL_TOO_FAR');
  });

  it('TEST 4 — final SL kind is FVG when sweep invalid', () => {
    const r = resolveValidStop({
      direction: 'long',
      entry: 1000,
      sweepExtreme: 100,
      fvgTop: 995,
      fvgBot: 990,
      atr: 20,
      bufferAtrRatio: 0.05,
      maxStopAtrMult: 1.5,
      stopModel: 'sweep',
      symbol: 'XAUUSD'
    });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'fvg');
  });

  it('TEST 5 — low RR rejected', () => {
    const v = validateMinRr({
      direction: 'short',
      entry: 53580,
      sl: 53700,
      tp1: 53550,
      minRr: 1.5
    });
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'SIGNAL_REJECTED_RR_TOO_LOW');
  });

  it('accepts RR at floor', () => {
    const v = validateMinRr({
      direction: 'long',
      entry: 100,
      sl: 90,
      tp1: 115,
      minRr: 1.5
    });
    assert.equal(v.ok, true);
    assert.ok(Math.abs(v.rr - 1.5) < 1e-9);
  });

  it('escapes JSON string values', () => {
    assert.equal(escapeJsonString('a"b\\c\nd'), 'a\\"b\\\\c\\nd');
  });

  it('sweep_or_fvg prefers closer valid stop, not farther', () => {
    const r = resolveValidStop({
      direction: 'short',
      entry: 1000,
      sweepExtreme: 1100,
      fvgTop: 1020,
      fvgBot: 1010,
      atr: 50,
      bufferAtrRatio: 0,
      maxStopAtrMult: 3,
      stopModel: 'sweep_or_fvg',
      symbol: 'EURUSD'
    });
    assert.equal(r.ok, true);
    assert.equal(r.kind, 'fvg');
  });
});
