/**
 * FairValueGapDetector — ICT 3-candle FVG.
 * Bullish: C1.high < C3.low
 * Bearish: C1.low > C3.high
 * Rejects gaps smaller than minGapToAtrRatio * ATR.
 * Optional doji on C3 is confidence-only.
 */

const { atr, candleMetrics } = require('../utils/candleMath');

class FairValueGapDetector {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {import('../types').Candle} c1
   * @param {import('../types').Candle} c2
   * @param {import('../types').Candle} c3
   * @param {number} c3Index
   * @param {import('../types').Candle[]} candles
   * @param {import('../types').TradeDirection} [direction]
   * @returns {import('../types').FairValueGap|null}
   */
  detectTriplet(c1, c2, c3, c3Index, candles, direction = null) {
    const bullish = c1.high < c3.low;
    const bearish = c1.low > c3.high;
    if (!bullish && !bearish) return null;

    const dir = bullish ? 'long' : 'short';
    if (direction && dir !== direction) return null;

    const gapBottom = bullish ? c1.high : c3.high;
    const gapTop = bullish ? c3.low : c1.low;
    const gapSize = gapTop - gapBottom;
    if (gapSize <= 0) return null;

    const atrPeriod = this.config.displacement?.atrPeriod || 14;
    const atrVal = atr(candles.slice(0, c3Index + 1), atrPeriod);
    const minRatio = this.config.fvg?.minGapToAtrRatio || 0.12;
    if (atrVal > 0 && gapSize / atrVal < minRatio) {
      return null; // tiny FVG rejected
    }

    const dojiMax = this.config.fvg?.dojiBodyRatioMax || 0.12;
    const m3 = candleMetrics(c3);
    const hasDojiOnC3 = m3.bodyRatio <= dojiMax;

    return {
      direction: dir,
      gapTop,
      gapBottom,
      gapSize,
      ce: (gapTop + gapBottom) / 2,
      c1Index: c3Index - 2,
      c2Index: c3Index - 1,
      c3Index,
      hasDojiOnC3
    };
  }

  /**
   * Find FVGs after displacement index, aligned with direction.
   * Never treats the displacement candle itself as the entry bar.
   *
   * @param {import('../types').Candle[]} candles
   * @param {import('../types').TradeDirection} direction
   * @param {number} afterIndex - typically displacement index (FVG C2 often = displacement)
   */
  findAfter(candles, direction, afterIndex) {
    const lookback = this.config.fvg?.lookbackBars || 18;
    const start = Math.max(2, afterIndex);
    const end = Math.min(candles.length - 1, start + lookback);

    /** @type {import('../types').FairValueGap[]} */
    const gaps = [];

    for (let i = start; i <= end; i += 1) {
      // Prefer FVG where C2 is the displacement candle (i-1 === afterIndex) or later
      if (i - 1 < afterIndex) continue;
      const fvg = this.detectTriplet(
        candles[i - 2],
        candles[i - 1],
        candles[i],
        i,
        candles,
        direction
      );
      if (fvg) gaps.push(fvg);
    }

    return gaps;
  }
}

module.exports = { FairValueGapDetector };
