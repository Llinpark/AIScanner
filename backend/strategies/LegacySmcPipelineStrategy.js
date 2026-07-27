/**
 * LegacySmcPipelineStrategy — adapter around existing TradingPipelineService.
 * Preserves prior daytrading SMC behavior without blocking the new Sweep+FVG daytrading strategy.
 */

const TradingPipelineService = require('../services/TradingPipelineService');
const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const { IStrategy } = require('./interfaces/IStrategy');
const { normalizeCandle } = require('./utils/candleMath');

const LEGACY_SMC_ID = 'daytrading_smc_pipeline';
const LEGACY_SMC_NAME = 'Daytrading SMC Pipeline';

class LegacySmcPipelineStrategy extends IStrategy {
  constructor(options = {}) {
    super();
    this.config = options.config || PATTERN_SCANNER_CONFIG;
    this._enabled =
      options.enabled !== false &&
      this.config.pipeline?.enabled !== false &&
      process.env.LEGACY_SMC_PIPELINE_STRATEGY !== 'false';
  }

  get id() {
    return LEGACY_SMC_ID;
  }

  get name() {
    return LEGACY_SMC_NAME;
  }

  get enabled() {
    return this._enabled;
  }

  analyze(context) {
    if (!this.enabled) {
      return { signal: false, stage: 'disabled', reason: 'legacy_smc_disabled' };
    }

    const candles = (context.candles || []).map(normalizeCandle);
    const htfCandles = (context.daytradingHtfCandles || context.htfCandles || []).map(normalizeCandle);
    const symbol = context.symbol || '';

    const pipelineResult = TradingPipelineService.runPipeline(candles, {
      config: this.config,
      symbol,
      htfCandles
    });

    if (pipelineResult.passed && pipelineResult.stage === 'entry') {
      return {
        signal: true,
        stage: 'entry',
        entry: {
          ...pipelineResult.entry,
          symbol,
          strategyName: pipelineResult.entry.strategyName || LEGACY_SMC_NAME,
          strategyId: LEGACY_SMC_ID
        },
        diagnostics: { pipeline: pipelineResult }
      };
    }

    if (pipelineResult.stage === 'pending_retrace' && pipelineResult.pending) {
      return {
        signal: false,
        stage: 'pending_retrace',
        pending: { ...pipelineResult.pending, strategyId: LEGACY_SMC_ID, symbol },
        diagnostics: { pipeline: pipelineResult }
      };
    }

    if (pipelineResult.stage === 'below_premium_threshold') {
      return {
        signal: false,
        stage: 'below_premium_threshold',
        reason: 'below_premium_threshold',
        diagnostics: { pipeline: pipelineResult }
      };
    }

    return {
      signal: false,
      stage: pipelineResult.stage || 'none',
      reason: pipelineResult.reason || 'no_setup',
      diagnostics: { pipeline: pipelineResult }
    };
  }

  continuePending(candles, pending, context = {}) {
    const normalized = candles.map(normalizeCandle);
    const result = TradingPipelineService.checkPendingRetracement(normalized, pending, {
      config: this.config,
      symbol: context.symbol || pending.symbol || '',
      htfCandles: (context.htfCandles || []).map(normalizeCandle)
    });

    if (result.expired) {
      return { signal: false, stage: 'rejected', reason: result.reason || 'expired', pending: null };
    }

    if (result.passed && result.stage === 'entry') {
      return {
        signal: true,
        stage: 'entry',
        entry: {
          ...result.entry,
          symbol: context.symbol || pending.symbol,
          strategyId: LEGACY_SMC_ID,
          strategyName: result.entry.strategyName || LEGACY_SMC_NAME
        },
        pending: null
      };
    }

    if (result.stage === 'pending_retrace') {
      return { signal: false, stage: 'pending_retrace', pending: result.pending || pending };
    }

    return {
      signal: false,
      stage: result.stage || 'none',
      reason: result.reason,
      pending: null
    };
  }
}

module.exports = {
  LegacySmcPipelineStrategy,
  LEGACY_SMC_ID,
  LEGACY_SMC_NAME,
  // Back-compat aliases used by older imports
  DayTradingStrategy: LegacySmcPipelineStrategy,
  DAYTRADING_ID: LEGACY_SMC_ID,
  DAYTRADING_NAME: LEGACY_SMC_NAME
};
