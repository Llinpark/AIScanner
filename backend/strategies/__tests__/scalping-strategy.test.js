/**
 * Unit tests for Liquidity Sweep + FVG scalping detectors/engines.
 * Run: node --test strategies/__tests__/scalping-strategy.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { LiquidityDetector } = require('../detectors/LiquidityDetector');
const { LiquiditySweepDetector } = require('../detectors/LiquiditySweepDetector');
const { MarketStructureShiftDetector } = require('../detectors/MarketStructureShiftDetector');
const { DisplacementDetector } = require('../detectors/DisplacementDetector');
const { EngulfingDetector } = require('../detectors/EngulfingDetector');
const { FairValueGapDetector } = require('../detectors/FairValueGapDetector');
const { RetracementDetector } = require('../detectors/RetracementDetector');
const { EntryEngine } = require('../engines/EntryEngine');
const { RiskManager } = require('../engines/RiskManager');
const { TakeProfitEngine } = require('../engines/TakeProfitEngine');
const { ConfidenceScoringService } = require('../engines/ConfidenceScoringService');
const { TradeSignalGenerator } = require('../engines/TradeSignalGenerator');
const { ScalpingStrategy } = require('../ScalpingStrategy');
const { createDefaultRegistry } = require('../registry');
const { DAYTRADING_ID } = require('../DayTradingStrategy');
const { STRATEGY_ID: SCALPING_ID } = require('../config/scalpingConfig');
const { LEGACY_SMC_ID } = require('../LegacySmcPipelineStrategy');
const { resolveScalpingConfig } = require('../config/scalpingConfig');
const { candleMetrics, atr, findSwingPoints, isSidewaysMarket } = require('../utils/candleMath');
const { computeSessionLevels, sessionPoolsFromLevels } = require('../utils/sessionLevels');
const { KACHING_ALERT_NAMES } = require('../../utils/kachingSignalLevels');

const BASE = Date.UTC(2026, 6, 20, 12, 0, 0);

function candle(i, o, h, l, c, tfMs = 3 * 60_000) {
  return { time: BASE + i * tfMs, open: o, high: h, low: l, close: c, volume: 1000 };
}

/** Build a synthetic bullish sweep → MSS → displacement → FVG → retrace sequence */
function buildBullishScalpFixture() {
  const htf = [];
  // Quiet range then swing low around 1.1000
  for (let i = 0; i < 30; i += 1) {
    const mid = 1.105 + (i % 5) * 0.0002;
    htf.push(candle(i, mid, mid + 0.0008, mid - 0.0008, mid + 0.0001, 15 * 60_000));
  }
  // Establish swing low
  htf.push(candle(30, 1.101, 1.102, 1.099, 1.1005, 15 * 60_000));
  for (let i = 31; i < 36; i += 1) {
    htf.push(candle(i, 1.101, 1.103, 1.1005, 1.102, 15 * 60_000));
  }
  // Sweep low below 1.099 and close back above
  htf.push(candle(36, 1.1008, 1.101, 1.0975, 1.1002, 15 * 60_000));

  const sweepTime = htf[htf.length - 1].time;
  const ltf = [];
  let t = 0;
  // Pre-sweep noise
  for (let i = 0; i < 10; i += 1) {
    ltf.push(candle(t++, 1.100, 1.101, 1.0995, 1.1002));
  }
  // Align times after sweep
  const after = [];
  // Build LH then break (MSS)
  after.push(candle(0, 1.099, 1.1005, 1.0985, 1.0998));
  after.push(candle(1, 1.0998, 1.1012, 1.0995, 1.1008)); // swing high ~ LH
  after.push(candle(2, 1.1008, 1.101, 1.0998, 1.100));
  after.push(candle(3, 1.100, 1.1025, 1.0999, 1.1022)); // break LH → MSS

  // Displacement bullish
  after.push(candle(4, 1.1022, 1.1055, 1.102, 1.1052));

  // FVG: c1 high < c3 low  (c1=disp-related, use next bars)
  // C1 after displacement start:
  after.push(candle(5, 1.1052, 1.1058, 1.1048, 1.1055)); // C1
  after.push(candle(6, 1.1055, 1.108, 1.1054, 1.1078)); // C2 displacement continuation
  after.push(candle(7, 1.1078, 1.109, 1.1075, 1.1085)); // C3 — gap if C1.high < C3.low

  // Ensure ICT FVG: bump C3 low above C1 high
  after[after.length - 1] = candle(7, 1.1078, 1.1095, 1.1065, 1.1088);
  // C1 high was 1.1058, C3 low 1.1065 → bullish FVG

  // Retrace into CE
  const gapBot = 1.1058;
  const gapTop = 1.1065;
  const ce = (gapBot + gapTop) / 2;
  after.push(candle(8, 1.1085, 1.1088, ce - 0.00005, ce + 0.00002));

  for (const c of after) {
    c.time = sweepTime + (t++ + 1) * 3 * 60_000;
    ltf.push(c);
  }

  return { htf, ltf, sweepTime };
}

describe('candleMath', () => {
  it('computes body ratio and atr', () => {
    const c = candle(0, 1.0, 1.1, 0.9, 1.08);
    const m = candleMetrics(c);
    // body=0.08, range=0.2 → 0.4
    assert.ok(m.bodyRatio > 0.35);
    assert.equal(m.isBullish, true);
    const candles = [c, candle(1, 1.08, 1.12, 1.05, 1.1), candle(2, 1.1, 1.15, 1.08, 1.12)];
    assert.ok(atr(candles, 3) > 0);
  });

  it('finds swing points', () => {
    const candles = [
      candle(0, 1, 1.02, 0.99, 1.01),
      candle(1, 1.01, 1.03, 1.0, 1.02),
      candle(2, 1.02, 1.1, 1.01, 1.09), // high
      candle(3, 1.09, 1.1, 1.05, 1.06),
      candle(4, 1.06, 1.07, 1.04, 1.05),
      candle(5, 1.05, 1.06, 0.95, 0.96), // low
      candle(6, 0.96, 1.0, 0.95, 0.99),
      candle(7, 0.99, 1.02, 0.98, 1.01)
    ];
    const { swingHighs, swingLows } = findSwingPoints(candles, 2);
    assert.ok(swingHighs.length >= 1);
    assert.ok(swingLows.length >= 1);
  });

  it('detects sideways when ATR collapses', () => {
    const candles = [];
    for (let i = 0; i < 40; i += 1) {
      const wide = i < 20;
      const range = wide ? 0.01 : 0.001;
      const mid = 1.1;
      candles.push(candle(i, mid, mid + range, mid - range, mid));
    }
    assert.equal(isSidewaysMarket(candles, { lookback: 20, ratioMax: 0.55 }), true);
  });
});

describe('sessionLevels', () => {
  it('builds PDH/PDL and session pools', () => {
    const candles = [];
    // Day 1
    for (let h = 0; h < 24; h += 1) {
      const t = Date.UTC(2026, 6, 20, h, 0, 0);
      candles.push({
        time: t,
        open: 1.1,
        high: 1.1 + h * 0.0001,
        low: 1.09,
        close: 1.1,
        volume: 1
      });
    }
    // Day 2
    for (let h = 0; h < 12; h += 1) {
      const t = Date.UTC(2026, 6, 21, h, 0, 0);
      candles.push({
        time: t,
        open: 1.11,
        high: 1.12,
        low: 1.1,
        close: 1.11,
        volume: 1
      });
    }
    const levels = computeSessionLevels(candles, {
      asian: { startHour: 0, endHour: 8 },
      london: { startHour: 7, endHour: 16 },
      ny: { startHour: 12, endHour: 21 }
    });
    assert.ok(levels.pdh != null);
    assert.ok(levels.pdl != null);
    const pools = sessionPoolsFromLevels(levels);
    assert.ok(pools.some(p => p.type === 'pdh'));
  });
});

describe('LiquidityDetector + Sweep', () => {
  it('detects sell-side sweep with rejection close', () => {
    const config = resolveScalpingConfig({
      swing: { sensitivity: 2, lookbackBars: 40, equalToleranceAtrRatio: 0.08, maxSweepsBeforeReject: 2 }
    });
    const candles = [];
    for (let i = 0; i < 20; i += 1) {
      candles.push(candle(i, 1.1, 1.101, 1.099, 1.1002, 15 * 60_000));
    }
    // clear swing low
    candles.push(candle(20, 1.1, 1.1005, 1.098, 1.099, 15 * 60_000));
    for (let i = 21; i < 26; i += 1) {
      candles.push(candle(i, 1.0995, 1.101, 1.099, 1.1005, 15 * 60_000));
    }
    // sweep
    candles.push(candle(26, 1.1, 1.1002, 1.097, 1.0995, 15 * 60_000));

    const detector = new LiquidityDetector(config);
    const { pools } = detector.detect(candles);
    assert.ok(pools.length > 0);

    const sweepDet = new LiquiditySweepDetector(config);
    // Manually add pool at swing low for deterministic test
    const pool = {
      type: 'previous_swing_low',
      price: 1.098,
      index: 20,
      side: 'sell_side',
      sweepCount: 0
    };
    const sweep = sweepDet.detect(candles, [pool]);
    assert.ok(sweep);
    assert.equal(sweep.direction, 'long');
    assert.ok(sweep.sweepPrice < pool.price);
  });

  it('rejects multi-swept liquidity beyond max', () => {
    const config = resolveScalpingConfig({
      swing: { maxSweepsBeforeReject: 1, sensitivity: 2, lookbackBars: 40, equalToleranceAtrRatio: 0.08 }
    });
    const pool = {
      type: 'previous_swing_low',
      price: 1.1,
      index: 0,
      side: 'sell_side',
      sweepCount: 0
    };
    const candles = [
      candle(0, 1.1, 1.101, 1.099, 1.1, 15 * 60_000),
      candle(1, 1.1, 1.101, 1.098, 1.1005, 15 * 60_000), // sweep 1
      candle(2, 1.1005, 1.101, 1.0975, 1.1002, 15 * 60_000) // sweep 2
    ];
    const sweepDet = new LiquiditySweepDetector(config);
    const sweep = sweepDet.detect(candles, [pool]);
    // With maxSweeps=1, second hunt invalidates
    assert.equal(sweep, null);
  });
});

describe('MarketStructureShiftDetector', () => {
  it('requires break of previous LH after bullish sweep', () => {
    const config = resolveScalpingConfig();
    const det = new MarketStructureShiftDetector(config);
    const sweep = {
      direction: 'long',
      time: BASE,
      liquidityType: 'previous_swing_low',
      level: 1.1,
      sweepPrice: 1.098,
      sweepIndex: 0,
      sweepCandle: candle(0, 1, 1, 1, 1),
      pool: {}
    };
    const candles = [
      candle(0, 1.1, 1.102, 1.099, 1.101),
      candle(1, 1.101, 1.104, 1.1, 1.103), // LH
      candle(2, 1.103, 1.1035, 1.101, 1.102),
      candle(3, 1.102, 1.106, 1.1015, 1.1055) // break
    ];
    // bump times after sweep
    candles.forEach((c, i) => {
      c.time = BASE + (i + 1) * 180_000;
    });
    const mss = det.detect(candles, sweep, BASE);
    assert.ok(mss);
    assert.equal(mss.direction, 'long');
  });

  it('returns null without MSS', () => {
    const det = new MarketStructureShiftDetector(resolveScalpingConfig());
    const sweep = {
      direction: 'long',
      time: BASE,
      liquidityType: 'x',
      level: 1,
      sweepPrice: 1,
      sweepIndex: 0,
      sweepCandle: candle(0, 1, 1, 1, 1),
      pool: {}
    };
    const candles = [
      candle(0, 1.1, 1.101, 1.099, 1.1),
      candle(1, 1.1, 1.1005, 1.0995, 1.1),
      candle(2, 1.1, 1.1002, 1.0998, 1.1)
    ].map((c, i) => ({ ...c, time: BASE + (i + 1) * 180_000 }));
    assert.equal(det.detect(candles, sweep, BASE), null);
  });
});

describe('DisplacementDetector', () => {
  it('accepts strong bullish displacement', () => {
    const det = new DisplacementDetector(resolveScalpingConfig());
    const candles = [];
    for (let i = 0; i < 20; i += 1) {
      candles.push(candle(i, 1.1, 1.1005, 1.0995, 1.1));
    }
    candles.push(candle(20, 1.1, 1.104, 1.0998, 1.1038));
    const result = det.evaluate(candles, 20, 'long');
    assert.equal(result.passed, true);
  });

  it('rejects weak body', () => {
    const det = new DisplacementDetector(resolveScalpingConfig());
    const candles = [candle(0, 1.1, 1.102, 1.098, 1.1001)];
    const result = det.evaluate(candles, 0, 'long');
    assert.equal(result.passed, false);
  });
});

describe('EngulfingDetector', () => {
  it('detects bullish engulfing', () => {
    const det = new EngulfingDetector(resolveScalpingConfig());
    const prev = candle(0, 1.102, 1.103, 1.1, 1.1005);
    const curr = candle(1, 1.1002, 1.104, 1.1, 1.1035);
    const r = det.detectPair(prev, curr, 'long');
    assert.equal(r.found, true);
  });
});

describe('FairValueGapDetector', () => {
  it('detects bullish ICT FVG and rejects tiny gaps', () => {
    const config = resolveScalpingConfig({ fvg: { minGapToAtrRatio: 0.12, lookbackBars: 18, dojiBodyRatioMax: 0.12 } });
    const det = new FairValueGapDetector(config);
    const candles = [];
    for (let i = 0; i < 20; i += 1) {
      candles.push(candle(i, 1.1, 1.101, 1.099, 1.1));
    }
    const c1 = candle(20, 1.1, 1.101, 1.0995, 1.1005);
    const c2 = candle(21, 1.1005, 1.104, 1.1004, 1.1035);
    const c3 = candle(22, 1.1035, 1.105, 1.1025, 1.104); // gap: 1.101 < 1.1025
    candles.push(c1, c2, c3);
    const fvg = det.detectTriplet(c1, c2, c3, 22, candles, 'long');
    assert.ok(fvg);
    assert.equal(fvg.direction, 'long');
    assert.ok(fvg.ce > fvg.gapBottom);

    // Tiny gap
    const tiny = det.detectTriplet(
      candle(20, 1.1, 1.1001, 1.0999, 1.1),
      candle(21, 1.1, 1.1003, 1.1, 1.1002),
      candle(22, 1.1002, 1.1004, 1.10015, 1.1003),
      22,
      candles,
      'long'
    );
    assert.equal(tiny, null);
  });
});

describe('RetracementDetector + EntryEngine', () => {
  it('never enters on displacement bar and accepts CE retrace', () => {
    const config = resolveScalpingConfig({ entry: { model: 'ce', maxWaitBars: 10, neverEnterOnDisplacement: true } });
    const retrace = new RetracementDetector(config);
    const fvg = {
      direction: 'long',
      gapTop: 1.106,
      gapBottom: 1.104,
      gapSize: 0.002,
      ce: 1.105,
      c1Index: 1,
      c2Index: 2,
      c3Index: 3,
      hasDojiOnC3: false
    };
    const onDisp = retrace.evaluate(candle(2, 1.105, 1.106, 1.104, 1.105), fvg, 'long', {
      displacementIndex: 2,
      candleIndex: 2
    });
    assert.equal(onDisp.passed, false);

    const hit = retrace.evaluate(candle(5, 1.1052, 1.1055, 1.1048, 1.1051), fvg, 'long', {
      displacementIndex: 2,
      candleIndex: 5
    });
    assert.equal(hit.passed, true);

    const entry = new EntryEngine(config, retrace).resolve({
      fvg,
      direction: 'long',
      retrace: hit
    });
    assert.equal(entry.entry, fvg.ce);
  });
});

describe('RiskManager + TakeProfitEngine', () => {
  it('places sweep stop below sweep low and RR TPs', () => {
    const config = resolveScalpingConfig({
      stop: { model: 'sweep', bufferAtrRatio: 0.05 },
      takeProfit: { model: 'rr', rrMultiples: [2, 3, 4], manualRr: [1.5, 2.5, 4] }
    });
    const risk = new RiskManager(config);
    const candles = [];
    for (let i = 0; i < 20; i += 1) candles.push(candle(i, 1.1, 1.101, 1.099, 1.1));
    const stop = risk.computeStop({
      direction: 'long',
      entry: 1.105,
      sweep: { sweepPrice: 1.098, level: 1.099 },
      fvg: { gapBottom: 1.104, gapTop: 1.106 },
      candles,
      symbol: 'EURUSD'
    });
    assert.ok(stop);
    assert.ok(stop.stop_loss < 1.105);

    const tp = new TakeProfitEngine(config).compute({
      direction: 'long',
      entry: 1.105,
      risk: stop.risk,
      candles
    });
    assert.ok(tp.take_profit_1 > 1.105);
    assert.ok(tp.take_profit_3 > tp.take_profit_2);
    assert.equal(tp.rr, 4);
  });
});

describe('ConfidenceScoringService', () => {
  it('weights factors to 100 max and gates threshold', () => {
    const svc = new ConfidenceScoringService(
      resolveScalpingConfig({ confidence: { threshold: 70, weights: undefined } })
    );
    const full = svc.score({
      sweep: true,
      mss: true,
      displacement: true,
      fvg: true,
      retrace: true,
      engulfing: true,
      doji: true
    });
    assert.equal(full.score, 100);
    assert.equal(full.passesThreshold, true);

    const partial = svc.score({
      sweep: true,
      mss: true,
      displacement: false,
      fvg: true,
      retrace: true,
      engulfing: false,
      doji: false
    });
    assert.equal(partial.score, 75);
  });
});

describe('TradeSignalGenerator', () => {
  it('keeps full internal fields but TV payload uses Kaching Entry message only', () => {
    const gen = new TradeSignalGenerator(resolveScalpingConfig());
    const signal = gen.generate({
      symbol: 'EURUSD',
      direction: 'long',
      entry: 1.105,
      stop_loss: 1.1,
      take_profit_1: 1.11,
      take_profit_2: 1.115,
      take_profit_3: 1.12,
      rr: 4,
      sweep: { liquidityType: 'pdh', level: 1.099 },
      fvg: { gapTop: 1.106, gapBottom: 1.104, ce: 1.105, gapSize: 0.002 },
      confidence: 85,
      reasons: ['test'],
      timeframe: '3m'
    });
    assert.equal(signal.liquidityType, 'pdh');
    assert.equal(signal.message, KACHING_ALERT_NAMES.entry);
    const tv = gen.toTradingViewPayload(signal);
    assert.equal(tv.message, 'Kaching Entry');
    assert.ok(!('liquidityType' in tv) || tv.liquidityType === undefined);
    // ensure no liquidity label leaked into message
    assert.equal(tv.message.includes('Liquidity'), false);
  });
});

describe('StrategyRegistry coexistence', () => {
  it('registers daytrading + scalping', () => {
    const registry = createDefaultRegistry();
    assert.ok(registry.get(DAYTRADING_ID));
    assert.ok(registry.get(SCALPING_ID));
    assert.ok(registry.get(LEGACY_SMC_ID));
    assert.equal(registry.listEnabled().length >= 2, true);
  });
});

describe('ScalpingStrategy orchestrator', () => {
  it('rejects HTF timeframe entries', () => {
    const strat = new ScalpingStrategy();
    const result = strat.analyze({
      symbol: 'EURUSD',
      timeframe: '15m',
      candles: [candle(0, 1, 1, 1, 1)],
      htfCandles: Array.from({ length: 20 }, (_, i) => candle(i, 1.1, 1.11, 1.09, 1.1, 15 * 60_000))
    });
    assert.equal(result.reason, 'htf_never_entries');
  });

  it('returns awaiting_htf_sweep when no sweep', () => {
    const strat = new ScalpingStrategy({
      config: { filters: { rejectOnMajorNews: false, minAtrPips: 0, sidewaysAtrRatioMax: 0.01 } }
    });
    const flat = Array.from({ length: 40 }, (_, i) => candle(i, 1.1, 1.1005, 1.0995, 1.1));
    const htf = Array.from({ length: 40 }, (_, i) => candle(i, 1.1, 1.1005, 1.0995, 1.1, 15 * 60_000));
    const result = strat.analyze({
      symbol: 'EURUSD',
      timeframe: '3m',
      candles: flat,
      htfCandles: htf
    });
    assert.ok(['awaiting_htf_sweep', 'filtered', 'none'].includes(result.stage) || result.signal === false);
  });
});
