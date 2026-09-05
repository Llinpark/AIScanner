/**
 * MarketStructureShiftDetector — LTF MSS after HTF sweep.
 * Bullish: sweep low → break previous Lower High (LH).
 * Bearish: sweep high → break previous Higher Low (HL).
 */

const { findSwingPoints } = require('../utils/candleMath');

class MarketStructureShiftDetector {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {import('../types').Candle[]} ltfCandles
   * @param {import('../types').LiquiditySweep} sweep
   * @param {number} [afterTime] - only structure after HTF sweep time
   * @returns {import('../types').MarketStructureShift|null}
   */
  detect(ltfCandles, sweep, afterTime = null) {
    if (!ltfCandles?.length || !sweep) return null;

    const lookback = this.config.mss?.structureLookbackBars || 24;
    const window = this.config.swing?.sensitivity || 2;
    const minTime = afterTime ?? sweep.time;

    // Ignore LTF bars before the HTF sweep
    let startIdx = 0;
    for (let i = 0; i < ltfCandles.length; i += 1) {
      if (ltfCandles[i].time >= minTime) {
        startIdx = i;
        break;
      }
    }

    const sliceStart = Math.max(0, startIdx - lookback);
    const context = ltfCandles.slice(sliceStart);
    if (context.length < 3) {
      return null;
    }

    const { swingLows, swingHighs } = findSwingPoints(context, window);

    // Fallback: if pivots are not yet confirmed (short window), use local extrema
    const fallbackHighs = () => {
      if (swingHighs.length) return swingHighs;
      let best = 0;
      for (let i = 1; i < context.length - 1; i += 1) {
        if (context[i].high >= context[best].high) best = i;
      }
      return [{ index: best, price: context[best].high, time: context[best].time, type: 'high' }];
    };
    const fallbackLows = () => {
      if (swingLows.length) return swingLows;
      let best = 0;
      for (let i = 1; i < context.length - 1; i += 1) {
        if (context[i].low <= context[best].low) best = i;
      }
      return [{ index: best, price: context[best].low, time: context[best].time, type: 'low' }];
    };

    if (sweep.direction === 'long') {
      const candidateHighs = fallbackHighs().slice(-4);
      if (!candidateHighs.length) return null;

      // Previous LH = swing high that formed before the break candle
      for (let h = candidateHighs.length - 1; h >= 0; h -= 1) {
        const lh = candidateHighs[h];
        for (let i = lh.index + 1; i < context.length; i += 1) {
          if (context[i].time < minTime) continue;
          if (context[i].close > lh.price) {
            return {
              direction: 'long',
              breakPrice: context[i].close,
              breakIndex: sliceStart + i,
              structureLevel: lh.price,
              reason: 'broke_previous_lh'
            };
          }
        }
      }
      return null;
    }

    // Bearish: break previous higher-low (HL)
    const candidateLows = fallbackLows().slice(-4);
    if (!candidateLows.length) return null;

    for (let h = candidateLows.length - 1; h >= 0; h -= 1) {
      const hl = candidateLows[h];
      for (let i = hl.index + 1; i < context.length; i += 1) {
        if (context[i].time < minTime) continue;
        if (context[i].close < hl.price) {
          return {
            direction: 'short',
            breakPrice: context[i].close,
            breakIndex: sliceStart + i,
            structureLevel: hl.price,
            reason: 'broke_previous_hl'
          };
        }
      }
    }

    return null;
  }
}

module.exports = { MarketStructureShiftDetector };
