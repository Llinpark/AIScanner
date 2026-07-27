/**
 * EngulfingDetector — preferred confirmation (confidence boost).
 * Bullish: current body engulfs prior bearish body.
 * Bearish: current body engulfs prior bullish body.
 * Not mandatory unless config.engulfing.required === true.
 */

const { candleMetrics } = require('../utils/candleMath');

class EngulfingDetector {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {import('../types').Candle} prev
   * @param {import('../types').Candle} curr
   * @param {import('../types').TradeDirection} [direction]
   * @returns {import('../types').EngulfingResult}
   */
  detectPair(prev, curr, direction = null) {
    if (!prev || !curr) return { found: false };

    const p = candleMetrics(prev);
    const c = candleMetrics(curr);
    const prevTop = Math.max(prev.open, prev.close);
    const prevBot = Math.min(prev.open, prev.close);
    const currTop = Math.max(curr.open, curr.close);
    const currBot = Math.min(curr.open, curr.close);

    const bullishEngulf = !p.isBullish && c.isBullish && currTop >= prevTop && currBot <= prevBot;
    const bearishEngulf = p.isBullish && !c.isBullish && currTop >= prevTop && currBot <= prevBot;

    if (direction === 'long' && bullishEngulf) return { found: true, direction: 'long' };
    if (direction === 'short' && bearishEngulf) return { found: true, direction: 'short' };
    if (!direction && bullishEngulf) return { found: true, direction: 'long' };
    if (!direction && bearishEngulf) return { found: true, direction: 'short' };

    return { found: false };
  }

  /**
   * Search a short window around displacement / MSS for an engulfing candle.
   * @param {import('../types').Candle[]} candles
   * @param {number} aroundIndex
   * @param {import('../types').TradeDirection} direction
   */
  findNear(candles, aroundIndex, direction) {
    const lookback = this.config.engulfing?.lookbackBars || 6;
    const start = Math.max(1, aroundIndex - lookback);
    const end = Math.min(candles.length - 1, aroundIndex + 1);

    for (let i = end; i >= start; i -= 1) {
      const result = this.detectPair(candles[i - 1], candles[i], direction);
      if (result.found) {
        return { ...result, index: i };
      }
    }

    return { found: false };
  }
}

module.exports = { EngulfingDetector };
