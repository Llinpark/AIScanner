const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateFromInputs,
  isMarketClosed,
  clearMemoryCache
} = require('../../services/MarketRegimeService');
const {
  applyMarketRegimeConfig,
  resetMarketRegimeConfigForTests,
  getMarketRegimeConfig
} = require('../marketRegimeConfig');

/** Build flat EURUSD-like candles with controllable range (ATR proxy). */
function makeCandles({ count = 40, range = 0.0012, base = 1.1, volume = 1000 } = {}) {
  const candles = [];
  let t = Date.UTC(2026, 6, 1, 12, 0, 0);
  for (let i = 0; i < count; i += 1) {
    const open = base + i * 0.00001;
    candles.push({
      time: t + i * 60_000,
      open,
      high: open + range,
      low: open - range * 0.1,
      close: open + range * 0.4,
      volume
    });
  }
  return candles;
}

describe('MarketRegimeService.evaluateFromInputs', () => {
  beforeEach(() => {
    resetMarketRegimeConfigForTests();
    clearMemoryCache();
    applyMarketRegimeConfig({
      enabled: true,
      minAtrPips: 3,
      maxSpreadPips: 25,
      minVolatilityScore: 20,
      avoidHighImpactNews: true,
      avoidLowLiquiditySessions: false,
      allowAsianSession: true,
      allowLondonSession: true,
      allowNewYorkSession: true,
      allowSessionOverlap: true,
      minRegimeScore: 40
    });
  });

  it('exposes enabled-by-default market regime config', () => {
    resetMarketRegimeConfigForTests();
    const cfg = getMarketRegimeConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.minRegimeScore, 40);
    assert.equal(cfg.minAtrPips, 3);
    assert.equal(cfg.maxSpreadPipsByClass.forex, 2.5);
    assert.equal(cfg.maxSpreadPipsByClass.gold, 5);
    assert.equal(cfg.maxSpreadPipsByClass.indices, 10);
  });

  it('skips when ATR is below minimum (filter enabled)', () => {
    // EURUSD pip=0.0001 → range 0.0001 = 1 pip ATR-ish
    const candles = makeCandles({ range: 0.00005, volume: 1000 });
    const result = evaluateFromInputs({
      symbol: 'EURUSD',
      timeframe: '15m',
      candles,
      spreadPips: 1,
      now: new Date(Date.UTC(2026, 6, 1, 14, 0, 0)), // Wed London/NY
      volatilityScore: 50
    });
    assert.equal(result.shouldScan, false);
    assert.ok(
      result.regime === 'LOW_LIQUIDITY' || result.regime === 'RANGING',
      `unexpected regime ${result.regime}`
    );
    assert.ok(result.reasons.some(r => /ATR/i.test(r) || /minimum/i.test(r)));
  });

  it('skips on high-impact news when avoidHighImpactNews is on', () => {
    // First Friday July 2026 = July 3
    const nfp = new Date(Date.UTC(2026, 6, 3, 13, 0, 0));
    const candles = makeCandles({ range: 0.0015 });
    const result = evaluateFromInputs({
      symbol: 'EURUSD',
      timeframe: '15m',
      candles,
      spreadPips: 1.2,
      now: nfp,
      volatilityScore: 60
    });
    assert.equal(result.shouldScan, false);
    assert.equal(result.regime, 'NEWS');
    assert.ok(result.reasons.some(r => /news|NFP|employment/i.test(r)));
  });

  it('skips when FX market is closed (weekend)', () => {
    const saturday = new Date(Date.UTC(2026, 6, 4, 12, 0, 0)); // Sat
    assert.equal(isMarketClosed(saturday, 'EURUSD'), true);
    const candles = makeCandles({ range: 0.0015 });
    const result = evaluateFromInputs({
      symbol: 'EURUSD',
      timeframe: '15m',
      candles,
      spreadPips: 1,
      now: saturday,
      volatilityScore: 60
    });
    assert.equal(result.shouldScan, false);
    assert.equal(result.regime, 'MARKET_CLOSED');
  });

  it('skips when score is below minRegimeScore', () => {
    applyMarketRegimeConfig({
      enabled: true,
      minRegimeScore: 95,
      minAtrPips: 0,
      minVolatilityScore: 0,
      avoidHighImpactNews: false
    });
    const candles = makeCandles({ range: 0.0012 });
    const result = evaluateFromInputs({
      symbol: 'EURUSD',
      timeframe: '15m',
      candles,
      spreadPips: 1,
      now: new Date(Date.UTC(2026, 6, 1, 14, 0, 0)),
      volatilityScore: 50
    });
    assert.equal(result.shouldScan, false);
    assert.ok(result.reasons.some(r => /score/i.test(r)));
  });

  it('allows scan when filter is disabled even if conditions are poor', () => {
    applyMarketRegimeConfig({ enabled: false, minRegimeScore: 99 });
    const saturday = new Date(Date.UTC(2026, 6, 4, 12, 0, 0));
    const result = evaluateFromInputs({
      symbol: 'EURUSD',
      timeframe: '15m',
      candles: makeCandles({ range: 0.00001 }),
      now: saturday
    });
    assert.equal(result.shouldScan, true);
  });

  it('allows a healthy London session with normal ATR', () => {
    const candles = makeCandles({ range: 0.0012, volume: 2000 });
    const result = evaluateFromInputs({
      symbol: 'EURUSD',
      timeframe: '15m',
      candles,
      spreadPips: 1.5,
      now: new Date(Date.UTC(2026, 6, 1, 10, 0, 0)), // Wed 10:00 UTC London
      volatilityScore: 55
    });
    assert.equal(result.shouldScan, true);
    assert.ok(result.score >= 40);
    assert.ok(['TRENDING', 'RANGING', 'HIGH_VOLATILITY'].includes(result.regime));
  });

  it('skips when symbol spread exceeds class-specific maximum', () => {
    const candles = makeCandles({ range: 0.0012, volume: 2000 });
    const result = evaluateFromInputs({
      symbol: 'EURUSD',
      timeframe: '15m',
      candles,
      spreadPips: 3.5, // forex default max is 2.5
      now: new Date(Date.UTC(2026, 6, 1, 10, 0, 0)),
      volatilityScore: 55
    });
    assert.equal(result.shouldScan, false);
    assert.equal(result.metrics.maxSpreadPips, 2.5);
    assert.ok(result.reasons.some(r => /spread/i.test(r)));
  });

  it('uses gold-specific max spread for XAUUSD', () => {
    const candles = makeCandles({ range: 2.5, base: 2650, volume: 2000 });
    const result = evaluateFromInputs({
      symbol: 'XAUUSD',
      timeframe: '15m',
      candles,
      spreadPips: 4.5, // under gold default of 5
      now: new Date(Date.UTC(2026, 6, 1, 10, 0, 0)),
      volatilityScore: 55,
      config: { minAtrPips: 0, minVolatilityScore: 0, avoidHighImpactNews: false }
    });
    assert.equal(result.metrics.maxSpreadPips, 5);
    assert.equal(result.shouldScan, true);
  });

  it('degrades gracefully without candles/spread (does not throw)', () => {
    const result = evaluateFromInputs({
      symbol: 'EURUSD',
      timeframe: '15m',
      candles: [],
      now: new Date(Date.UTC(2026, 6, 1, 14, 0, 0)),
      config: { minAtrPips: 0, minVolatilityScore: 0, avoidHighImpactNews: false }
    });
    assert.equal(typeof result.shouldScan, 'boolean');
    assert.ok(Array.isArray(result.reasons));
    assert.ok(result.reasons.some(r => /Degraded|unavailable/i.test(r)));
  });
});
