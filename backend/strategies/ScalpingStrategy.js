/**
 * ScalpingStrategy — orchestrates Liquidity Sweep + FVG (Scalping).
 *
 * Philosophy (all required before signal):
 * 1. HTF (15m) liquidity swept
 * 2. LTF (3m/1m) MSS
 * 3. FVG forms
 * 4. Price retraces into FVG
 *
 * DI: detectors/engines injected for testability.
 */

const { resolveScalpingConfig, STRATEGY_ID, STRATEGY_NAME } = require('./config/scalpingConfig');
const { IStrategy } = require('./interfaces/IStrategy');
const { LiquidityDetector } = require('./detectors/LiquidityDetector');
const { LiquiditySweepDetector } = require('./detectors/LiquiditySweepDetector');
const { MarketStructureShiftDetector } = require('./detectors/MarketStructureShiftDetector');
const { DisplacementDetector } = require('./detectors/DisplacementDetector');
const { EngulfingDetector } = require('./detectors/EngulfingDetector');
const { FairValueGapDetector } = require('./detectors/FairValueGapDetector');
const { RetracementDetector } = require('./detectors/RetracementDetector');
const { EntryEngine } = require('./engines/EntryEngine');
const { RiskManager } = require('./engines/RiskManager');
const { TakeProfitEngine } = require('./engines/TakeProfitEngine');
const { ConfidenceScoringService } = require('./engines/ConfidenceScoringService');
const { TradeSignalGenerator } = require('./engines/TradeSignalGenerator');
const { atr, toPips, isSidewaysMarket, normalizeCandle } = require('./utils/candleMath');
const { evaluateNewsImpact } = require('../utils/newsFilter');
const { resolveMaxSpreadPips } = require('../utils/maxSpreadLimits');

class ScalpingStrategy extends IStrategy {
  /**
   * @param {Object} [options]
   * @param {Object} [options.config]
   * @param {Object} [options.deps] - optional DI overrides
   */
  constructor(options = {}) {
    super();
    this.config = resolveScalpingConfig(options.config || {});
    const c = this.config;
    const d = options.deps || {};

    this.liquidityDetector = d.liquidityDetector || new LiquidityDetector(c);
    this.sweepDetector = d.sweepDetector || new LiquiditySweepDetector(c);
    this.mssDetector = d.mssDetector || new MarketStructureShiftDetector(c);
    this.displacementDetector = d.displacementDetector || new DisplacementDetector(c);
    this.engulfingDetector = d.engulfingDetector || new EngulfingDetector(c);
    this.fvgDetector = d.fvgDetector || new FairValueGapDetector(c);
    this.retraceDetector = d.retraceDetector || new RetracementDetector(c);
    this.entryEngine = d.entryEngine || new EntryEngine(c, this.retraceDetector);
    this.riskManager = d.riskManager || new RiskManager(c);
    this.tpEngine = d.tpEngine || new TakeProfitEngine(c);
    this.confidence = d.confidence || new ConfidenceScoringService(c);
    this.signalGenerator = d.signalGenerator || new TradeSignalGenerator(c);
  }

  get id() {
    return STRATEGY_ID;
  }

  get name() {
    return STRATEGY_NAME;
  }

  get enabled() {
    return this.config.enabled !== false;
  }

  /**
   * @param {import('./types').StrategyContext} context
   * @returns {import('./types').StrategyResult}
   */
  analyze(context) {
    if (!this.enabled) {
      return { signal: false, stage: 'disabled', reason: 'scalping_disabled' };
    }

    const symbol = context.symbol || '';
    const timeframe = context.timeframe || this.config.defaultEntryTimeframe;
    const entryTfs = this.config.entryTimeframes || ['3m', '1m'];

    // Hard rule: never enter on HTF
    if (timeframe === this.config.htfTimeframe || timeframe === '15m' || timeframe === '15') {
      return { signal: false, stage: 'rejected', reason: 'htf_never_entries' };
    }
    if (entryTfs.length && !entryTfs.includes(timeframe) && context.enforceEntryTf !== false) {
      // Allow analysis when caller passes explicit LTF candles without naming TF loosely
      if (context.strictTimeframe === true) {
        return { signal: false, stage: 'rejected', reason: 'invalid_entry_timeframe' };
      }
    }

    const ltf = (context.candles || []).map(normalizeCandle);
    const htf = (context.scalpingHtfCandles || context.htfCandles || []).map(normalizeCandle);

    if (htf.length < 16) {
      return { signal: false, stage: 'none', reason: 'insufficient_htf' };
    }
    if (ltf.length < 20) {
      return { signal: false, stage: 'none', reason: 'insufficient_ltf' };
    }

    // --- Filters ---
    const filterFail = this._runFilters(symbol, ltf, context);
    if (filterFail) return filterFail;

    // STEP 1 — Liquidity pools on 15m
    const state = context.state || null;
    if (state && typeof state === 'object' && context.cache) {
      context.cache.update(symbol, this.config.htfTimeframe, htf, this.config);
    }
    const { pools } = this.liquidityDetector.detect(htf, state);

    // STEP 1b — Sweep on 15m
    const sweep = this.sweepDetector.detect(htf, pools);
    if (!sweep) {
      return {
        signal: false,
        stage: 'awaiting_htf_sweep',
        reason: 'no_liquidity_sweep',
        diagnostics: { poolCount: pools.length }
      };
    }

    // STEP 2 — Switch to LTF only after valid M15 sweep; ignore pre-sweep setups
    // STEP 3 — MSS
    const mss = this.mssDetector.detect(ltf, sweep, sweep.time);
    if (!mss) {
      return {
        signal: false,
        stage: 'awaiting_mss',
        reason: 'no_mss',
        diagnostics: { sweep }
      };
    }

    // STEP 4 — Displacement
    const displacement = this.displacementDetector.findAfter(
      ltf,
      mss.breakIndex,
      sweep.direction
    );
    if (!displacement.passed) {
      return {
        signal: false,
        stage: 'rejected',
        reason: 'no_displacement',
        diagnostics: { sweep, mss, displacement }
      };
    }

    // STEP 5 — Engulfing (optional)
    const engulfing = this.engulfingDetector.findNear(
      ltf,
      displacement.index,
      sweep.direction
    );
    if (this.config.engulfing?.required && !engulfing.found) {
      return {
        signal: false,
        stage: 'rejected',
        reason: 'engulfing_required',
        diagnostics: { sweep, mss, displacement }
      };
    }

    // STEP 6 — FVG after displacement
    const gaps = this.fvgDetector.findAfter(ltf, sweep.direction, displacement.index);
    if (!gaps.length) {
      return {
        signal: false,
        stage: 'awaiting_fvg',
        reason: 'no_fvg',
        diagnostics: { sweep, mss, displacement }
      };
    }

    // Prefer the earliest valid FVG after displacement (classic ICT sequence)
    const fvg = gaps[0];

    // STEP 8 — Retrace into FVG (never on displacement)
    const retrace = this.retraceDetector.findRetrace(
      ltf,
      fvg,
      sweep.direction,
      displacement.index
    );

    if (retrace.pending) {
      return {
        signal: false,
        stage: 'pending_retrace',
        pending: {
          strategyId: this.id,
          symbol,
          direction: sweep.direction,
          sweep,
          mss,
          displacement,
          engulfing,
          fvg,
          createdAt: ltf[fvg.c3Index]?.time,
          expiresAfterBars: this.config.entry.maxWaitBars
        },
        diagnostics: { sweep, mss, displacement, fvg }
      };
    }

    if (!retrace.passed) {
      return {
        signal: false,
        stage: 'rejected',
        reason: retrace.reason || 'no_retrace',
        diagnostics: { sweep, mss, displacement, fvg, retrace }
      };
    }

    const entryResolved = this.entryEngine.resolve({
      fvg,
      direction: sweep.direction,
      retrace
    });
    if (!entryResolved) {
      return { signal: false, stage: 'rejected', reason: 'entry_resolve_failed' };
    }

    // STEP 9 — SL
    const stop = this.riskManager.computeStop({
      direction: sweep.direction,
      entry: entryResolved.entry,
      sweep,
      fvg,
      candles: ltf,
      symbol
    });
    if (!stop) {
      return { signal: false, stage: 'rejected', reason: 'invalid_stop' };
    }

    // STEP 10 — TPs
    const atrVal = atr(ltf, this.config.displacement?.atrPeriod || 14);
    const tps = this.tpEngine.compute({
      direction: sweep.direction,
      entry: entryResolved.entry,
      risk: stop.risk,
      candles: ltf,
      pools,
      atrValue: atrVal,
      symbol
    });

    // Confidence
    const scoring = this.confidence.score({
      sweep: true,
      mss: true,
      displacement: true,
      fvg: true,
      retrace: true,
      engulfing: Boolean(engulfing.found),
      doji: Boolean(fvg.hasDojiOnC3)
    });

    if (!scoring.passesThreshold) {
      return {
        signal: false,
        stage: 'below_confidence_threshold',
        reason: 'confidence_below_threshold',
        diagnostics: { scoring, sweep, fvg }
      };
    }

    const reasons = [
      `HTF sweep ${sweep.liquidityType} @ ${sweep.level}`,
      `MSS ${mss.reason}`,
      `Displacement bodyRatio=${(displacement.bodyRatio || 0).toFixed(2)}`,
      `FVG ${fvg.gapBottom}-${fvg.gapTop}`,
      `Retrace model=${retrace.model}`,
      engulfing.found ? 'Engulfing confirmation' : null,
      fvg.hasDojiOnC3 ? 'Doji on FVG C3' : null,
      `Confidence ${scoring.score}/${scoring.threshold}`
    ].filter(Boolean);

    const entry = this.signalGenerator.generate({
      symbol,
      direction: sweep.direction,
      entry: entryResolved.entry,
      stop_loss: stop.stop_loss,
      take_profit_1: tps.take_profit_1,
      take_profit_2: tps.take_profit_2,
      take_profit_3: tps.take_profit_3,
      rr: tps.rr,
      sweep,
      fvg,
      confidence: scoring.score,
      reasons,
      timeframe,
      timestamp: ltf[ltf.length - 1]?.time
    });

    return {
      signal: true,
      stage: 'entry',
      entry,
      diagnostics: {
        scoring,
        sweep,
        mss,
        displacement,
        engulfing,
        fvg,
        retrace,
        stop,
        tps
      }
    };
  }

  /**
   * Continue a pending FVG retrace without re-deriving HTF sweep.
   * @param {import('./types').Candle[]} ltfCandles
   * @param {Object} pending
   * @param {Object} [context]
   */
  continuePending(ltfCandles, pending, context = {}) {
    const ltf = ltfCandles.map(normalizeCandle);
    const { fvg, sweep, displacement, engulfing, mss, symbol } = pending;
    const direction = pending.direction || sweep.direction;
    const timeframe = context.timeframe || this.config.defaultEntryTimeframe;

    const filterFail = this._runFilters(symbol || context.symbol || '', ltf, context);
    if (filterFail) return filterFail;

    const barsSince = ltf.length - 1 - fvg.c3Index;
    if (barsSince > (pending.expiresAfterBars || this.config.entry.maxWaitBars)) {
      return { signal: false, stage: 'rejected', reason: 'retrace_timeout', pending: null };
    }

    const retrace = this.retraceDetector.findRetrace(
      ltf,
      fvg,
      direction,
      displacement.index
    );

    if (retrace.pending) {
      return { signal: false, stage: 'pending_retrace', pending };
    }
    if (!retrace.passed) {
      return { signal: false, stage: 'rejected', reason: retrace.reason, pending: null };
    }

    const entryResolved = this.entryEngine.resolve({ fvg, direction, retrace });
    if (!entryResolved) {
      return { signal: false, stage: 'rejected', reason: 'entry_resolve_failed', pending: null };
    }

    const stop = this.riskManager.computeStop({
      direction,
      entry: entryResolved.entry,
      sweep,
      fvg,
      candles: ltf,
      symbol: symbol || context.symbol || ''
    });
    if (!stop) {
      return { signal: false, stage: 'rejected', reason: 'invalid_stop', pending: null };
    }

    const pools = context.pools || [];
    const atrVal = atr(ltf, this.config.displacement?.atrPeriod || 14);
    const tps = this.tpEngine.compute({
      direction,
      entry: entryResolved.entry,
      risk: stop.risk,
      candles: ltf,
      pools,
      atrValue: atrVal,
      symbol: symbol || context.symbol || ''
    });

    const scoring = this.confidence.score({
      sweep: true,
      mss: true,
      displacement: true,
      fvg: true,
      retrace: true,
      engulfing: Boolean(engulfing?.found),
      doji: Boolean(fvg.hasDojiOnC3)
    });

    if (!scoring.passesThreshold) {
      return {
        signal: false,
        stage: 'below_confidence_threshold',
        reason: 'confidence_below_threshold',
        pending: null
      };
    }

    const reasons = [
      `HTF sweep ${sweep.liquidityType} @ ${sweep.level}`,
      mss?.reason ? `MSS ${mss.reason}` : 'MSS confirmed',
      `FVG retrace model=${retrace.model}`,
      `Confidence ${scoring.score}/${scoring.threshold}`
    ];

    const entry = this.signalGenerator.generate({
      symbol: symbol || context.symbol,
      direction,
      entry: entryResolved.entry,
      stop_loss: stop.stop_loss,
      take_profit_1: tps.take_profit_1,
      take_profit_2: tps.take_profit_2,
      take_profit_3: tps.take_profit_3,
      rr: tps.rr,
      sweep,
      fvg,
      confidence: scoring.score,
      reasons,
      timeframe,
      timestamp: ltf[ltf.length - 1]?.time
    });

    return { signal: true, stage: 'entry', entry, pending: null };
  }

  /** @private */
  _runFilters(symbol, ltf, context) {
    const f = this.config.filters || {};
    const atrPeriod = this.config.displacement?.atrPeriod || 14;
    const atrVal = atr(ltf, atrPeriod);
    const atrPips = toPips(atrVal, symbol);

    if (atrPips > 0 && atrPips < (f.minAtrPips || 2)) {
      return { signal: false, stage: 'filtered', reason: 'atr_too_small' };
    }

    if (isSidewaysMarket(ltf, {
      lookback: f.sidewaysLookback || 20,
      ratioMax: f.sidewaysAtrRatioMax || 0.55,
      atrPeriod
    })) {
      return { signal: false, stage: 'filtered', reason: 'sideways' };
    }

    if (context.spread != null && Number.isFinite(context.spread)) {
      const spreadPips = toPips(context.spread, symbol);
      const maxSpread = resolveMaxSpreadPips(symbol, f);
      if (spreadPips > maxSpread) {
        return { signal: false, stage: 'filtered', reason: 'spread_high' };
      }
    }

    if (f.rejectOnMajorNews !== false) {
      const news = evaluateNewsImpact(context.now || new Date());
      if (news.avoidNewEntries) {
        return {
          signal: false,
          stage: 'filtered',
          reason: 'major_news_active',
          diagnostics: { news }
        };
      }
    }

    return null;
  }
}

module.exports = { ScalpingStrategy };
