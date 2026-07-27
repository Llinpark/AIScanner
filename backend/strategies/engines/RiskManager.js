/**
 * RiskManager — stop loss placement.
 * Bullish: below sweep low OR below FVG (configurable).
 * Bearish: above sweep high OR above FVG.
 */

const { atr, getPipSize } = require('../utils/candleMath');

class RiskManager {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {Object} params
   * @param {import('../types').TradeDirection} params.direction
   * @param {number} params.entry
   * @param {import('../types').LiquiditySweep} params.sweep
   * @param {import('../types').FairValueGap} params.fvg
   * @param {import('../types').Candle[]} params.candles
   * @param {string} [params.symbol]
   * @returns {{ stop_loss: number, model: string, risk: number }|null}
   */
  computeStop({ direction, entry, sweep, fvg, candles, symbol = '' }) {
    if (!Number.isFinite(entry) || !sweep || !fvg) return null;

    const model = (this.config.stop?.model || 'sweep').toLowerCase();
    const atrVal = atr(candles, this.config.displacement?.atrPeriod || 14);
    const buffer = (this.config.stop?.bufferAtrRatio || 0.05) * (atrVal || getPipSize(symbol) * 2);

    let stop;
    let used = model;

    const sweepStop = direction === 'long' ? sweep.sweepPrice - buffer : sweep.sweepPrice + buffer;
    const fvgStop =
      direction === 'long' ? fvg.gapBottom - buffer : fvg.gapTop + buffer;

    if (model === 'fvg') {
      stop = fvgStop;
      used = 'fvg';
    } else if (model === 'sweep_or_fvg') {
      // More protective: farther from entry
      if (direction === 'long') {
        stop = Math.min(sweepStop, fvgStop);
      } else {
        stop = Math.max(sweepStop, fvgStop);
      }
      used = 'sweep_or_fvg';
    } else {
      stop = sweepStop;
      used = 'sweep';
    }

    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return null;

    // Sanity: long stop must be below entry
    if (direction === 'long' && stop >= entry) return null;
    if (direction === 'short' && stop <= entry) return null;

    return { stop_loss: stop, model: used, risk };
  }
}

module.exports = { RiskManager };
