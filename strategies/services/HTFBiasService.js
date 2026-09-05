/**
 * HTFBiasService — 4H institutional bias with optional 1H refine.
 * Returns bullish | bearish | neutral. Neutral → no day-trading signals.
 */

const { findSwingPoints } = require('../utils/candleMath');

class HTFBiasService {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {import('../types').Candle[]} htf4h
   * @param {import('../types').Candle[]} [htf1h]
   * @returns {{ bias: 'bullish'|'bearish'|'neutral', primary: Object, refine: Object|null, aligned: boolean }}
   */
  evaluate(htf4h, htf1h = []) {
    const primary = this._biasFromCandles(htf4h, '4h');
    let refine = null;
    let bias = primary.bias;
    let aligned = true;

    if (this.config.useRefineHtf !== false && htf1h?.length >= 10) {
      refine = this._biasFromCandles(htf1h, '1h');
      if (primary.bias === 'neutral') {
        bias = 'neutral';
      } else if (refine.bias === 'neutral') {
        // Keep primary when refine is flat
        bias = primary.bias;
        aligned = false;
      } else if (refine.bias !== primary.bias) {
        // Conflict → neutral unless config allows
        bias = 'neutral';
        aligned = false;
      } else {
        bias = primary.bias;
        aligned = true;
      }
    }

    return { bias, primary, refine, aligned };
  }

  /**
   * Map bias to trade direction or null when neutral.
   * @param {'bullish'|'bearish'|'neutral'} bias
   * @returns {import('../types').TradeDirection|null}
   */
  toDirection(bias) {
    if (bias === 'bullish') return 'long';
    if (bias === 'bearish') return 'short';
    return null;
  }

  /** @private */
  _biasFromCandles(candles, label) {
    const cfg = this.config.htfBias || {};
    const period = cfg.smaPeriod || 20;
    const structureLookback = cfg.structureLookback || 12;

    if (!candles || candles.length < Math.max(period + 2, structureLookback)) {
      return { bias: 'neutral', label, reason: 'insufficient_htf', sma: null };
    }

    const closes = candles.map(c => c.close);
    const sma = closes.slice(-period).reduce((a, b) => a + b, 0) / period;
    const last = candles[candles.length - 1];
    const aboveSma = last.close > sma;
    const belowSma = last.close < sma;

    const slice = candles.slice(-Math.max(structureLookback + 4, 16));
    const { swingHighs, swingLows } = findSwingPoints(slice, this.config.swing?.sensitivity || 3);

    let structureBias = 'neutral';
    if (swingHighs.length >= 2 && swingLows.length >= 2) {
      const h1 = swingHighs[swingHighs.length - 2].price;
      const h2 = swingHighs[swingHighs.length - 1].price;
      const l1 = swingLows[swingLows.length - 2].price;
      const l2 = swingLows[swingLows.length - 1].price;
      if (h2 > h1 && l2 > l1) structureBias = 'bullish';
      else if (h2 < h1 && l2 < l1) structureBias = 'bearish';
    }

    let bias = 'neutral';
    if (aboveSma && structureBias === 'bullish') bias = 'bullish';
    else if (belowSma && structureBias === 'bearish') bias = 'bearish';
    else if (aboveSma && structureBias !== 'bearish') bias = 'bullish';
    else if (belowSma && structureBias !== 'bullish') bias = 'bearish';

    return {
      bias,
      label,
      sma,
      structureBias,
      close: last.close,
      reason: `${label}_${bias}`
    };
  }
}

module.exports = { HTFBiasService };
