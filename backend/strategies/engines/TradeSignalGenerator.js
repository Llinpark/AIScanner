/**
 * TradeSignalGenerator — maps internal strategy output to delivery-ready signal.
 * Strategy name/id/pattern come from config so scalping + daytrading share this engine.
 * TV display path uses only Kaching Entry / SL / TP1–3.
 */

const { KACHING_ALERT_NAMES } = require('../../utils/kachingSignalLevels');

class TradeSignalGenerator {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {Object} params
   * @returns {import('../types').InternalTradeSignal}
   */
  generate(params) {
    const {
      symbol,
      direction,
      entry,
      stop_loss,
      take_profit_1,
      take_profit_2,
      take_profit_3,
      rr,
      sweep,
      fvg,
      confidence,
      reasons,
      timeframe,
      timestamp,
      htfTimeframe,
      entryTimeframe,
      htfBias,
      tpPartials
    } = params;

    const strategyName = this.config.name || 'Kaching Strategy';
    const strategyId = this.config.id || 'kaching_strategy';
    const pattern = strategyId;

    return {
      symbol,
      direction,
      entry,
      stop_loss,
      stop_loss_1: stop_loss,
      take_profit_1,
      take_profit_2,
      take_profit_3,
      rr,
      liquidityType: sweep?.liquidityType || null,
      liquidityLevel: sweep?.level ?? null,
      fvg: fvg
        ? {
            top: fvg.gapTop,
            bottom: fvg.gapBottom,
            ce: fvg.ce,
            size: fvg.gapSize,
            createdAt: fvg.c3Index != null ? undefined : undefined
          }
        : null,
      gapTop: fvg?.gapTop,
      gapBottom: fvg?.gapBottom,
      confidence: typeof confidence === 'number' ? confidence / 100 : confidence,
      confidenceScore: confidence,
      reasons: reasons || [],
      timestamp: timestamp || Date.now(),
      timeframe: timeframe || this.config.defaultEntryTimeframe || '15m',
      htfTimeframe: htfTimeframe || this.config.htfTimeframe || null,
      entryTimeframe: entryTimeframe || timeframe || this.config.defaultEntryTimeframe,
      htfBias: htfBias || null,
      tpPartials: tpPartials || null,
      strategyName,
      strategyId,
      pattern,
      patternLabel: strategyName,
      alertType: 'entry',
      signalQuality: confidence >= (this.config.confidence?.threshold || 70) ? 'premium' : 'standard',
      message: KACHING_ALERT_NAMES.entry,
      tvDisplay: {
        entry: KACHING_ALERT_NAMES.entry,
        stop_loss: KACHING_ALERT_NAMES.stop_loss,
        take_profit_1: KACHING_ALERT_NAMES.take_profit_1,
        take_profit_2: KACHING_ALERT_NAMES.take_profit_2,
        take_profit_3: KACHING_ALERT_NAMES.take_profit_3
      }
    };
  }

  /**
   * @param {import('../types').InternalTradeSignal} signal
   */
  toTradingViewPayload(signal) {
    return {
      symbol: signal.symbol,
      strategyName: signal.strategyName,
      timeframe: signal.timeframe,
      pattern: signal.pattern,
      alertType: 'entry',
      direction: signal.direction,
      entry: signal.entry,
      stop_loss: signal.stop_loss,
      stop_loss_1: signal.stop_loss,
      take_profit_1: signal.take_profit_1,
      take_profit_2: signal.take_profit_2,
      take_profit_3: signal.take_profit_3,
      gapTop: signal.gapTop,
      gapBottom: signal.gapBottom,
      confidence: signal.confidence,
      message: KACHING_ALERT_NAMES.entry,
      broadcast: true
    };
  }
}

module.exports = { TradeSignalGenerator };
