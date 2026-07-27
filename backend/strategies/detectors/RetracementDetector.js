/**
 * RetracementDetector — wait for price to retrace into the FVG.
 * Never enter on the displacement candle itself.
 * Models: entire | upper_half | lower_half | ce (default).
 */

class RetracementDetector {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Compute the valid entry zone for the selected model.
   * @param {import('../types').FairValueGap} fvg
   * @param {import('../types').TradeDirection} direction
   * @param {string} [model]
   * @returns {{ top: number, bottom: number, ideal: number, model: string }}
   */
  zoneForModel(fvg, direction, model = null) {
    const m = (model || this.config.entry?.model || 'ce').toLowerCase();
    const mid = fvg.ce;
    const halfTop = (fvg.gapTop + mid) / 2;
    const halfBot = (fvg.gapBottom + mid) / 2;

    switch (m) {
      case 'upper_half':
        // For longs, upper half is premium of the gap (closer to gapTop)
        return {
          top: fvg.gapTop,
          bottom: mid,
          ideal: direction === 'long' ? halfTop : mid,
          model: 'upper_half'
        };
      case 'lower_half':
        return {
          top: mid,
          bottom: fvg.gapBottom,
          ideal: direction === 'long' ? mid : halfBot,
          model: 'lower_half'
        };
      case 'entire':
      case 'entire_fvg':
        return {
          top: fvg.gapTop,
          bottom: fvg.gapBottom,
          ideal: mid,
          model: 'entire'
        };
      case 'ce':
      default:
        // CE 50%: treat a thin band around equilibrium as the trigger
        {
          const band = fvg.gapSize * 0.08;
          return {
            top: mid + band,
            bottom: mid - band,
            ideal: mid,
            model: 'ce'
          };
        }
    }
  }

  /**
   * @param {import('../types').Candle} candle
   * @param {import('../types').FairValueGap} fvg
   * @param {import('../types').TradeDirection} direction
   * @param {{ displacementIndex?: number, candleIndex?: number }} [meta]
   * @returns {import('../types').RetracementResult}
   */
  evaluate(candle, fvg, direction, meta = {}) {
    if (this.config.entry?.neverEnterOnDisplacement !== false) {
      if (
        meta.displacementIndex != null &&
        meta.candleIndex != null &&
        meta.candleIndex <= meta.displacementIndex
      ) {
        return { passed: false, reason: 'never_enter_on_displacement' };
      }
    }

    const zone = this.zoneForModel(fvg, direction);
    const touches =
      candle.low <= zone.top && candle.high >= zone.bottom;

    if (!touches) {
      return { passed: false, reason: 'price_outside_fvg_zone', model: zone.model };
    }

    // Entry price: CE ideal when model is ce; otherwise clamp close into zone
    let entryPrice = zone.ideal;
    if (zone.model === 'entire') {
      entryPrice = Math.min(Math.max(candle.close, zone.bottom), zone.top);
    } else if (zone.model === 'upper_half' || zone.model === 'lower_half') {
      entryPrice = Math.min(Math.max(zone.ideal, zone.bottom), zone.top);
    }

    return {
      passed: true,
      entryPrice,
      model: zone.model
    };
  }

  /**
   * Scan bars after FVG formation for first valid retrace.
   * @param {import('../types').Candle[]} candles
   * @param {import('../types').FairValueGap} fvg
   * @param {import('../types').TradeDirection} direction
   * @param {number} displacementIndex
   */
  findRetrace(candles, fvg, direction, displacementIndex) {
    const maxWait = this.config.entry?.maxWaitBars || 10;
    const start = fvg.c3Index + 1;
    const end = Math.min(candles.length - 1, fvg.c3Index + maxWait);

    if (start > end) {
      return { passed: false, reason: 'waiting_for_retrace_bars', pending: true };
    }

    // Reject if fully mitigated through the far side before entry
    for (let i = start; i <= end; i += 1) {
      const c = candles[i];
      if (direction === 'long' && c.close < fvg.gapBottom) {
        return { passed: false, reason: 'fvg_mitigated' };
      }
      if (direction === 'short' && c.close > fvg.gapTop) {
        return { passed: false, reason: 'fvg_mitigated' };
      }

      const hit = this.evaluate(c, fvg, direction, {
        displacementIndex,
        candleIndex: i
      });
      if (hit.passed) {
        return { ...hit, index: i };
      }
    }

    if (end >= candles.length - 1 && end - fvg.c3Index < maxWait) {
      return { passed: false, reason: 'pending_retrace', pending: true };
    }

    return { passed: false, reason: 'retrace_timeout' };
  }
}

module.exports = { RetracementDetector };
