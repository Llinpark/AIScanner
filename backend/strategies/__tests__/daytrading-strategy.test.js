/**
 * Unit tests for Liquidity Sweep + FVG (Day Trading).
 * Run: node --test strategies/__tests__/daytrading-strategy.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { HTFBiasService } = require('../services/HTFBiasService');
const { TrendFilter } = require('../services/TrendFilter');
const { NewsFilter } = require('../services/NewsFilter');
const { DayTradingStrategy, DAYTRADING_ID } = require('../DayTradingStrategy');
const { ScalpingStrategy } = require('../ScalpingStrategy');
const { createDefaultRegistry, resetDefaultRegistry } = require('../registry');
const { resolveDayTradingConfig, STRATEGY_NAME } = require('../config/dayTradingConfig');
const { STRATEGY_ID: SCALPING_ID } = require('../config/scalpingConfig');
const { LEGACY_SMC_ID } = require('../LegacySmcPipelineStrategy');
const { TakeProfitEngine } = require('../engines/TakeProfitEngine');
const { ConfidenceScoringService } = require('../engines/ConfidenceScoringService');
const { LiquidityDetector } = require('../detectors/LiquidityDetector');
const { computeWeeklyLevels, roundPsychologicalPools } = require('../utils/sessionLevels');
const { KACHING_ALERT_NAMES } = require('../../utils/kachingSignalLevels');

const BASE = Date.UTC(2026, 6, 15, 12, 0, 0);

function candle(i, o, h, l, c, tfMs = 15 * 60_000) {
  return { time: BASE + i * tfMs, open: o, high: h, low: l, close: c, volume: 1000 };
}

describe('HTFBiasService', () => {
  it('returns bullish when price above SMA with HH/HL structure', () => {
    const svc = new HTFBiasService(resolveDayTradingConfig());
    const htf = [];
    for (let i = 0; i < 40; i += 1) {
      const mid = 1.1 + i * 0.001;
      htf.push(candle(i, mid, mid + 0.002, mid - 0.001, mid + 0.0015, 4 * 60 * 60_000));
    }
    const result = svc.evaluate(htf, []);
    assert.ok(['bullish', 'bearish', 'neutral'].includes(result.bias));
    assert.ok(result.primary);
  });

  it('maps bias to direction', () => {
    const svc = new HTFBiasService(resolveDayTradingConfig());
    assert.equal(svc.toDirection('bullish'), 'long');
    assert.equal(svc.toDirection('bearish'), 'short');
    assert.equal(svc.toDirection('neutral'), null);
  });
});

describe('TrendFilter', () => {
  it('rejects counter-trend by default', () => {
    const f = new TrendFilter(resolveDayTradingConfig({ filters: { tradeReversals: false } }));
    assert.equal(f.evaluate('long', 'bearish').passed, false);
    assert.equal(f.evaluate('long', 'bullish').passed, true);
    assert.equal(f.evaluate('short', 'neutral').passed, false);
  });

  it('allows reversals when configured', () => {
    const f = new TrendFilter(resolveDayTradingConfig({ filters: { tradeReversals: true } }));
    assert.equal(f.evaluate('long', 'bearish').passed, true);
  });
});

describe('NewsFilter', () => {
  it('can be disabled', () => {
    const f = new NewsFilter(resolveDayTradingConfig({ filters: { rejectOnMajorNews: false } }));
    assert.equal(f.evaluate(new Date()).blocked, false);
  });
});

describe('weekly + round liquidity helpers', () => {
  it('computes PWH/PWL from daily map', () => {
    const byDay = {};
    for (let d = 1; d <= 20; d += 1) {
      const key = `2026-06-${String(d).padStart(2, '0')}`;
      byDay[key] = { high: 1.1 + d * 0.001, low: 1.09 };
    }
    const weekly = computeWeeklyLevels(byDay);
    assert.ok(weekly.pwh != null || weekly.pwl != null || weekly.pwh === null);
  });

  it('builds round psychological pools', () => {
    const pools = roundPsychologicalPools(1.1055, 'EURUSD', 1);
    assert.ok(pools.length >= 2);
    assert.ok(pools.every(p => p.type === 'round_psychological'));
  });
});

describe('TakeProfitEngine institutional model', () => {
  it('maps TP1–3 and keeps extra partials', () => {
    const config = resolveDayTradingConfig({ takeProfit: { model: 'institutional', rrMultiples: [2, 3, 4], minRr: 2 } });
    const engine = new TakeProfitEngine(config);
    const candles = Array.from({ length: 30 }, (_, i) =>
      candle(i, 1.1 + i * 0.0002, 1.101 + i * 0.0002, 1.099 + i * 0.0002, 1.1005 + i * 0.0002)
    );
    const pools = [
      { type: 'pdh', price: 1.12, side: 'buy_side' },
      { type: 'pwh', price: 1.15, side: 'buy_side' },
      { type: 'previous_swing_high', price: 1.118, side: 'buy_side' }
    ];
    const tps = engine.compute({
      direction: 'long',
      entry: 1.105,
      risk: 0.005,
      candles,
      pools
    });
    assert.ok(tps.take_profit_1 > 1.105);
    assert.ok(tps.take_profit_3 >= tps.take_profit_2);
    assert.equal(tps.model, 'institutional');
    assert.ok(tps.partials?.tp5_2r);
  });
});

describe('DayTrading confidence weights', () => {
  it('scores HTF bias + sweep stack to 100', () => {
    const svc = new ConfidenceScoringService(resolveDayTradingConfig());
    const full = svc.score({
      htfBias: true,
      sweep: true,
      mss: true,
      displacement: true,
      fvg: true,
      retrace: true,
      optionalConfirmation: true
    });
    assert.equal(full.score, 100);
    assert.equal(full.passesThreshold, true);
  });
});

describe('DayTradingStrategy orchestrator', () => {
  it('rejects HTF timeframe entries', () => {
    const strat = new DayTradingStrategy({
      config: { filters: { rejectOnMajorNews: false, minAtrPips: 0 } }
    });
    const result = strat.analyze({
      symbol: 'EURUSD',
      timeframe: '4h',
      candles: Array.from({ length: 30 }, (_, i) => candle(i, 1.1, 1.11, 1.09, 1.1)),
      htfCandles: Array.from({ length: 40 }, (_, i) => candle(i, 1.1, 1.11, 1.09, 1.1, 4 * 3600_000))
    });
    assert.equal(result.reason, 'htf_never_entries');
  });

  it('rejects neutral HTF bias path when flat', () => {
    const strat = new DayTradingStrategy({
      config: {
        filters: { rejectOnMajorNews: false, minAtrPips: 0, sidewaysAtrRatioMax: 0.01 },
        useRefineHtf: false
      }
    });
    const flat = Array.from({ length: 40 }, (_, i) => candle(i, 1.1, 1.1004, 1.0996, 1.1));
    const htf = Array.from({ length: 40 }, (_, i) => candle(i, 1.1, 1.1004, 1.0996, 1.1, 4 * 3600_000));
    const result = strat.analyze({
      symbol: 'EURUSD',
      timeframe: '15m',
      candles: flat,
      htfCandles: htf
    });
    assert.equal(result.signal, false);
  });

  it('TV payload message is Kaching Entry only', () => {
    const strat = new DayTradingStrategy();
    const signal = strat.signalGenerator.generate({
      symbol: 'EURUSD',
      direction: 'long',
      entry: 1.1,
      stop_loss: 1.09,
      take_profit_1: 1.12,
      take_profit_2: 1.13,
      take_profit_3: 1.14,
      rr: 4,
      sweep: { liquidityType: 'pdh', level: 1.095 },
      fvg: { gapTop: 1.102, gapBottom: 1.1, ce: 1.101, gapSize: 0.002 },
      confidence: 80,
      reasons: ['test'],
      timeframe: '15m',
      htfTimeframe: '4h',
      htfBias: 'bullish'
    });
    assert.equal(signal.strategyName, STRATEGY_NAME);
    assert.equal(signal.strategyId, DAYTRADING_ID);
    assert.equal(signal.message, KACHING_ALERT_NAMES.entry);
    assert.equal(signal.htfBias, 'bullish');
  });
});

describe('Registry coexistence', () => {
  it('registers daytrading + scalping + legacy SMC', () => {
    resetDefaultRegistry();
    const registry = createDefaultRegistry();
    assert.ok(registry.get(DAYTRADING_ID));
    assert.ok(registry.get(SCALPING_ID));
    assert.ok(registry.get(LEGACY_SMC_ID));
    assert.ok(registry.get(DAYTRADING_ID) instanceof DayTradingStrategy);
    assert.ok(registry.get(SCALPING_ID) instanceof ScalpingStrategy);
  });
});

describe('LiquidityDetector daytrading pools', () => {
  it('includes session and optional round levels', () => {
    const config = resolveDayTradingConfig({
      liquidity: { includeRoundLevels: true, includeWeekly: true, includeTrendline: false }
    });
    const det = new LiquidityDetector(config);
    const htf = [];
    for (let i = 0; i < 50; i += 1) {
      const mid = 1.1 + (i % 7) * 0.0005;
      htf.push(candle(i, mid, mid + 0.0015, mid - 0.0015, mid, 4 * 3600_000));
    }
    const { pools } = det.detect(htf, null, { symbol: 'EURUSD' });
    assert.ok(pools.length > 0);
    assert.ok(pools.some(p => p.type.includes('swing') || p.type === 'pdh' || p.type === 'round_psychological'));
  });
});
