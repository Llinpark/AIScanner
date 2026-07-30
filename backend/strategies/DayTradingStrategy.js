/**
 * DayTradingStrategy — Liquidity Sweep + Fair Value Gap (Day Trading).
 *
 * HTF 4H bias (+ optional 1H refine) — NEVER entries.
 * Entries ONLY on 15m / 5m after: HTF sweep → MSS → displacement → FVG → retrace → min RR.
 *
 * Shares SMC detectors with ScalpingStrategy (Liquidity*, MSS, Displacement, FVG, Retrace, etc.).
 */

const { resolveDayTradingConfig, STRATEGY_ID, STRATEGY_NAME } = require('./config/dayTradingConfig');
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
const { HTFBiasService } = require('./services/HTFBiasService');
const { TrendFilter } = require('./services/TrendFilter');
const { NewsFilter } = require('./services/NewsFilter');
const { atr, toPips, isSidewaysMarket, normalizeCandle, candleMetrics } = require('./utils/candleMath');

class DayTradingStrategy extends IStrategy {
  /**
   * @param {Object} [options]
   * @param {Object} [options.config]
   * @param {Object} [options.deps]
   */
  constructor(options = {}) {
    super();
    this.config = resolveDayTradingConfig(options.config || {});
    const c = this.config;
    const d = options.deps || {};

    this.htfBias = d.htfBias || new HTFBiasService(c);
    this.trendFilter = d.trendFilter || new TrendFilter(c);
    this.newsFilter = d.newsFilter || new NewsFilter(c);
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
      return { signal: false, stage: 'disabled', reason: 'daytrading_sweep_fvg_disabled' };
    }

    const symbol = context.symbol || '';
    const timeframe = context.timeframe || this.config.defaultEntryTimeframe;
    const entryTfs = this.config.entryTimeframes || ['15m', '5m'];

    if (
      timeframe === this.config.htfTimeframe ||
      timeframe === '4h' ||
      timeframe === '240' ||
      timeframe === '1h' ||
      timeframe === '60'
    ) {
      return { signal: false, stage: 'rejected', reason: 'htf_never_entries' };
    }

    if (context.strictTimeframe === true && entryTfs.length && !entryTfs.includes(timeframe)) {
      return { signal: false, stage: 'rejected', reason: 'invalid_entry_timeframe' };
    }

    const ltf = (context.candles || []).map(normalizeCandle);
    const htf4h = (context.htf4hCandles || context.daytradingHtfCandles || context.htfCandles || []).map(
      normalizeCandle
    );
    const htf1h = (context.htf1hCandles || context.refineHtfCandles || []).map(normalizeCandle);

    if (htf4h.length < 24) {
      return { signal: false, stage: 'none', reason: 'insufficient_htf_4h' };
    }
    if (ltf.length < 24) {
      return { signal: false, stage: 'none', reason: 'insufficient_ltf' };
    }

    // News filter
    const news = this.newsFilter.evaluate(context.now || new Date());
    if (news.blocked) {
      return {
        signal: false,
        stage: 'filtered',
        reason: news.reason || 'major_news_active',
        diagnostics: { news }
      };
    }

    // Market condition filters
    const filterFail = this._runMarketFilters(symbol, ltf, context);
    if (filterFail) return filterFail;

    // Max simultaneous trades per symbol (caller may pass openTradeCount)
    const maxTrades = this.config.filters?.maxSimultaneousTradesPerSymbol || 1;
    if ((context.openTradeCount || 0) >= maxTrades) {
      return { signal: false, stage: 'filtered', reason: 'max_trades_per_symbol' };
    }

    // STEP 1 — HTF Bias (no signals when Neutral)
    const biasResult = this.htfBias.evaluate(htf4h, htf1h);
    if (biasResult.bias === 'neutral') {
      return {
        signal: false,
        stage: 'rejected',
        reason: 'neutral_htf_bias',
        diagnostics: { biasResult }
      };
    }

    // STEP 2 — Institutional liquidity + sweep on HTF (4H preferred)
    const { pools, sessionLevels } = this.liquidityDetector.detect(htf4h, context.state || null, {
      symbol
    });
    const sweep = this.sweepDetector.detect(htf4h, pools);
    if (!sweep) {
      return {
        signal: false,
        stage: 'awaiting_htf_sweep',
        reason: 'no_liquidity_sweep',
        diagnostics: { biasResult, poolCount: pools.length }
      };
    }

    // Trend filter — reject counter-trend unless tradeReversals
    const trend = this.trendFilter.evaluate(sweep.direction, biasResult.bias);
    if (!trend.passed) {
      return {
        signal: false,
        stage: 'filtered',
        reason: trend.reason,
        diagnostics: { biasResult, sweep }
      };
    }

    // STEP 3 — MSS on entry TF
    const mss = this.mssDetector.detect(ltf, sweep, sweep.time);
    if (!mss) {
      return {
        signal: false,
        stage: 'awaiting_mss',
        reason: 'no_mss',
        diagnostics: { biasResult, sweep }
      };
    }

    // STEP 4 — Displacement
    const displacement = this.displacementDetector.findAfter(ltf, mss.breakIndex, sweep.direction);
    if (!displacement.passed) {
      return {
        signal: false,
        stage: 'rejected',
        reason: 'no_displacement',
        diagnostics: { biasResult, sweep, mss, displacement }
      };
    }

    // Optional confirmations (confidence only)
    const engulfing = this.engulfingDetector.findNear(ltf, displacement.index, sweep.direction);
    const rejectionInZone = this._rejectionWickInContext(ltf, displacement.index, sweep.direction);
    const momentumCont = (displacement.bodyRatio || 0) >= 0.75;
    const optionalConfirmation =
      Boolean(engulfing.found) || rejectionInZone || momentumCont;

    // STEP 5 — FVG
    const gaps = this.fvgDetector.findAfter(ltf, sweep.direction, displacement.index);
    if (!gaps.length) {
      return {
        signal: false,
        stage: 'awaiting_fvg',
        reason: 'no_fvg',
        diagnostics: { biasResult, sweep, mss, displacement }
      };
    }
    const fvg = gaps[0];

    // STEP 6–7 — Retrace into FVG (do not chase)
    const retrace = this.retraceDetector.findRetrace(ltf, fvg, sweep.direction, displacement.index);
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
          biasResult,
          pools,
          sessionLevels,
          createdAt: ltf[fvg.c3Index]?.time,
          expiresAfterBars: this.config.entry.maxWaitBars
        },
        diagnostics: { biasResult, sweep, mss, displacement, fvg }
      };
    }
    if (!retrace.passed) {
      return {
        signal: false,
        stage: 'rejected',
        reason: retrace.reason || 'no_retrace',
        diagnostics: { biasResult, sweep, fvg, retrace }
      };
    }

    // Do-not-chase: if price already blasted through far side of FVG without touching zone properly
    if (this.config.entry?.doNotChase) {
      const last = ltf[ltf.length - 1];
      if (sweep.direction === 'long' && last.close > fvg.gapTop && !retrace.passed) {
        return { signal: false, stage: 'rejected', reason: 'do_not_chase' };
      }
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

    // Max SL size vs ATR
    const atrVal = atr(ltf, this.config.displacement?.atrPeriod || 14);
    const maxSl = (this.config.stop?.maxStopAtrMult || 2.5) * (atrVal || 0);
    if (maxSl > 0 && stop.risk > maxSl) {
      return { signal: false, stage: 'filtered', reason: 'sl_too_large' };
    }

    // STEP 10 — TPs
    const tps = this.tpEngine.compute({
      direction: sweep.direction,
      entry: entryResolved.entry,
      risk: stop.risk,
      candles: ltf,
      pools,
      atrValue: atrVal,
      symbol,
      htfBias: biasResult?.bias || null
    });

    const minRr = this.config.takeProfit?.minRr ?? 1.2;
    if (!(tps.rr >= minRr)) {
      return {
        signal: false,
        stage: 'filtered',
        reason: 'insufficient_rr',
        diagnostics: { rr: tps.rr, minRr }
      };
    }

    const scoring = this.confidence.score({
      htfBias: true,
      sweep: true,
      mss: true,
      displacement: true,
      fvg: true,
      retrace: true,
      optionalConfirmation
    });

    if (!scoring.passesThreshold) {
      return {
        signal: false,
        stage: 'below_confidence_threshold',
        reason: 'confidence_below_threshold',
        diagnostics: { scoring }
      };
    }

    const reasons = [
      `HTF bias ${biasResult.bias}`,
      `HTF sweep ${sweep.liquidityType} @ ${sweep.level}`,
      `MSS ${mss.reason}`,
      `Displacement bodyRatio=${(displacement.bodyRatio || 0).toFixed(2)}`,
      `FVG ${fvg.gapBottom}-${fvg.gapTop} CE=${fvg.ce}`,
      `Retrace model=${retrace.model}`,
      optionalConfirmation ? 'Optional confirmation present' : null,
      `RR ${tps.rr.toFixed(2)} (min ${minRr})`,
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
      timestamp: ltf[ltf.length - 1]?.time,
      htfTimeframe: this.config.htfTimeframe,
      entryTimeframe: timeframe,
      htfBias: biasResult.bias,
      tpPartials: tps.partials || null
    });

    return {
      signal: true,
      stage: 'entry',
      entry,
      diagnostics: {
        scoring,
        biasResult,
        sweep,
        mss,
        displacement,
        engulfing,
        fvg,
        retrace,
        stop,
        tps,
        sessionLevels
      }
    };
  }

  continuePending(ltfCandles, pending, context = {}) {
    const ltf = ltfCandles.map(normalizeCandle);
    const { fvg, sweep, displacement, engulfing, mss, biasResult, pools, symbol } = pending;
    const direction = pending.direction || sweep.direction;
    const timeframe = context.timeframe || this.config.defaultEntryTimeframe;

    const news = this.newsFilter.evaluate(context.now || new Date());
    if (news.blocked) {
      return { signal: false, stage: 'filtered', reason: news.reason, pending: null };
    }

    const filterFail = this._runMarketFilters(symbol || context.symbol || '', ltf, context);
    if (filterFail) return { ...filterFail, pending: null };

    const barsSince = ltf.length - 1 - fvg.c3Index;
    if (barsSince > (pending.expiresAfterBars || this.config.entry.maxWaitBars)) {
      return { signal: false, stage: 'rejected', reason: 'retrace_timeout', pending: null };
    }

    const retrace = this.retraceDetector.findRetrace(ltf, fvg, direction, displacement.index);
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

    const tps = this.tpEngine.compute({
      direction,
      entry: entryResolved.entry,
      risk: stop.risk,
      candles: ltf,
      pools: pools || context.pools || [],
      atrValue: atr(ltf, this.config.displacement?.atrPeriod || 14),
      symbol: symbol || context.symbol || '',
      htfBias: biasResult?.bias || context.htfBias || null
    });

    const minRr = this.config.takeProfit?.minRr ?? 1.2;
    if (!(tps.rr >= minRr)) {
      return { signal: false, stage: 'filtered', reason: 'insufficient_rr', pending: null };
    }

    const optionalConfirmation = Boolean(engulfing?.found) || Boolean(fvg.hasDojiOnC3);
    const scoring = this.confidence.score({
      htfBias: true,
      sweep: true,
      mss: true,
      displacement: true,
      fvg: true,
      retrace: true,
      optionalConfirmation
    });
    if (!scoring.passesThreshold) {
      return {
        signal: false,
        stage: 'below_confidence_threshold',
        reason: 'confidence_below_threshold',
        pending: null
      };
    }

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
      reasons: [
        `HTF bias ${biasResult?.bias || 'aligned'}`,
        `HTF sweep ${sweep.liquidityType}`,
        mss?.reason ? `MSS ${mss.reason}` : 'MSS confirmed',
        `RR ${tps.rr.toFixed(2)}`,
        `Confidence ${scoring.score}`
      ],
      timeframe,
      timestamp: ltf[ltf.length - 1]?.time,
      htfTimeframe: this.config.htfTimeframe,
      entryTimeframe: timeframe,
      htfBias: biasResult?.bias,
      tpPartials: tps.partials || null
    });

    return { signal: true, stage: 'entry', entry, pending: null };
  }

  /** @private */
  _runMarketFilters(symbol, ltf, context) {
    const f = this.config.filters || {};
    const atrPeriod = this.config.displacement?.atrPeriod || 14;
    const atrVal = atr(ltf, atrPeriod);
    const atrPips = toPips(atrVal, symbol);

    if (atrPips > 0 && atrPips < (f.minAtrPips || 4)) {
      return { signal: false, stage: 'filtered', reason: 'atr_too_small' };
    }

    if (
      isSidewaysMarket(ltf, {
        lookback: f.sidewaysLookback || 24,
        ratioMax: f.sidewaysAtrRatioMax || 0.6,
        atrPeriod
      })
    ) {
      return { signal: false, stage: 'filtered', reason: 'ranging_market' };
    }

    if (context.spread != null && Number.isFinite(context.spread)) {
      const spreadPips = toPips(context.spread, symbol);
      if (spreadPips > (f.maxSpreadPips || 4)) {
        return { signal: false, stage: 'filtered', reason: 'spread_high' };
      }
    }

    return null;
  }

  /** @private */
  _rejectionWickInContext(candles, fromIndex, direction) {
    for (let i = Math.max(1, fromIndex); i < Math.min(candles.length, fromIndex + 4); i += 1) {
      const m = candleMetrics(candles[i]);
      if (direction === 'long' && m.lowerWick > m.body * 1.2) return true;
      if (direction === 'short' && m.upperWick > m.body * 1.2) return true;
    }
    return false;
  }
}

module.exports = {
  DayTradingStrategy,
  DAYTRADING_ID: STRATEGY_ID,
  DAYTRADING_NAME: STRATEGY_NAME
};
