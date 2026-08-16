/**
 * RiskManager — stop loss placement with max-ATR validation + FVG fallback.
 * Bullish: below sweep low OR below FVG (configurable).
 * Bearish: above sweep high OR above FVG.
 * Never clamps a structural stop arbitrarily closer to entry.
 */

const { atr, getPipSize } = require('../utils/candleMath');
const { resolveValidStop, isSyntheticSymbol } = require('../../utils/kachingSlRisk');

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
   * @returns {{ stop_loss: number, model: string, risk: number, rejectReason?: string }|null}
   */
  computeStop({ direction, entry, sweep, fvg, candles, symbol = '' }) {
    if (!Number.isFinite(entry) || !sweep || !fvg) return null;

    const atrVal = atr(candles, this.config.displacement?.atrPeriod || 14) || getPipSize(symbol) * 2;
    const bufferAtrRatio = this.config.stop?.bufferAtrRatio ?? 0.05;
    const maxStopAtrMult =
      this.config.stop?.maxStopAtrMult ??
      (isSyntheticSymbol(symbol) ? 1.5 : 2.5);
    const stopModel = (this.config.stop?.model || 'sweep').toLowerCase();

    const resolved = resolveValidStop({
      direction,
      entry,
      sweepExtreme: sweep.sweepPrice,
      fvgTop: fvg.gapTop,
      fvgBot: fvg.gapBottom,
      atr: atrVal,
      bufferAtrRatio,
      maxStopAtrMult,
      stopModel,
      symbol
    });

    if (!resolved.ok) {
      return {
        stop_loss: null,
        model: resolved.kind || stopModel,
        risk: resolved.distance || 0,
        rejectReason: resolved.reason || 'SIGNAL_REJECTED_SL_TOO_FAR',
        atr: atrVal,
        maxStopAtrMult,
        maxDistance: resolved.maxDistance
      };
    }

    return {
      stop_loss: resolved.sl,
      model: resolved.kind,
      risk: resolved.distance,
      atr: atrVal,
      maxStopAtrMult,
      maxDistance: resolved.maxDistance
    };
  }
}

module.exports = { RiskManager };
