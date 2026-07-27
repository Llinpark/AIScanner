/**
 * TrendFilter — only allow trades aligned with HTF bias unless tradeReversals.
 */

class TrendFilter {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {import('../types').TradeDirection} direction
   * @param {'bullish'|'bearish'|'neutral'} bias
   * @returns {{ passed: boolean, reason?: string }}
   */
  evaluate(direction, bias) {
    if (bias === 'neutral') {
      return { passed: false, reason: 'neutral_htf_bias' };
    }

    const allowReversal = this.config.filters?.tradeReversals === true;
    const aligned =
      (direction === 'long' && bias === 'bullish') ||
      (direction === 'short' && bias === 'bearish');

    if (aligned) return { passed: true, reason: 'with_trend' };
    if (allowReversal) return { passed: true, reason: 'reversal_allowed' };
    return { passed: false, reason: 'counter_trend_rejected' };
  }
}

module.exports = { TrendFilter };
