/**
 * DisplacementDetector — large body, small wick, close near extreme,
 * body > average body, range > ATR average. Rejects weak momentum.
 */

const { candleMetrics, atr, averageBody } = require('../utils/candleMath');

class DisplacementDetector {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Evaluate a specific candle as displacement in the trade direction.
   * @param {import('../types').Candle[]} candles
   * @param {number} index
   * @param {import('../types').TradeDirection} direction
   * @returns {import('../types').DisplacementResult}
   */
  evaluate(candles, index, direction) {
    const cfg = this.config.displacement || {};
    if (index < 0 || index >= candles.length) {
      return { passed: false, reason: 'bad_index' };
    }

    const c = candles[index];
    const m = candleMetrics(c);
    const period = cfg.atrPeriod || 14;
    const context = candles.slice(0, index + 1);
    const atrVal = atr(context, period);
    const avgBody = averageBody(context.slice(0, -1), period);

    if (m.bodyRatio < (cfg.minBodyRatio || 0.62)) {
      return { passed: false, reason: 'body_ratio_low', bodyRatio: m.bodyRatio };
    }
    if (m.wickRatio > (cfg.maxWickRatio || 0.32)) {
      return { passed: false, reason: 'wick_ratio_high' };
    }
    if (avgBody > 0 && m.body < avgBody * (cfg.minBodyToAvgRatio || 1.15)) {
      return { passed: false, reason: 'body_below_average' };
    }
    if (atrVal > 0 && m.range < atrVal * (cfg.minRangeToAtrRatio || 1.05)) {
      return { passed: false, reason: 'range_below_atr' };
    }

    const near = cfg.closeNearExtremeRatio || 0.25;
    if (direction === 'long') {
      if (!m.isBullish) return { passed: false, reason: 'not_bullish' };
      if (m.closeNearHigh > near) return { passed: false, reason: 'close_not_near_high' };
    } else {
      if (m.isBullish) return { passed: false, reason: 'not_bearish' };
      if (m.closeNearLow > near) return { passed: false, reason: 'close_not_near_low' };
    }

    return {
      passed: true,
      direction,
      index,
      bodyRatio: m.bodyRatio,
      rangeToAtr: atrVal > 0 ? m.range / atrVal : 0
    };
  }

  /**
   * Find the strongest displacement candle after MSS break index.
   * @param {import('../types').Candle[]} candles
   * @param {number} fromIndex
   * @param {import('../types').TradeDirection} direction
   * @param {number} [toIndex]
   */
  findAfter(candles, fromIndex, direction, toIndex = null) {
    const end = toIndex == null ? candles.length - 1 : toIndex;
    /** @type {import('../types').DisplacementResult|null} */
    let best = null;

    for (let i = Math.max(0, fromIndex); i <= end; i += 1) {
      const result = this.evaluate(candles, i, direction);
      if (!result.passed) continue;
      if (!best || (result.bodyRatio || 0) > (best.bodyRatio || 0)) {
        best = result;
      }
    }

    return best || { passed: false, reason: 'no_displacement' };
  }
}

module.exports = { DisplacementDetector };
