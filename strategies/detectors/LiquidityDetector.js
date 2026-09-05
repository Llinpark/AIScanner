/**
 * LiquidityDetector — shared SMC liquidity pools (scalping + daytrading).
 * Pools: Previous/Major Swing H/L, EQH/EQL, PDH/PDL, PWH/PWL, Session H/L,
 * optional round psychological levels / trendline liquidity.
 */

const { atr, findSwingPoints } = require('../utils/candleMath');
const {
  computeSessionLevels,
  computeWeeklyLevels,
  computeMonthlyLevels,
  sessionPoolsFromLevels,
  roundPsychologicalPools
} = require('../utils/sessionLevels');

class LiquidityDetector {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {import('../types').Candle[]} htfCandles
   * @param {Object} [state]
   * @param {{ symbol?: string }} [options]
   * @returns {{ pools: import('../types').LiquidityPool[], swings: Object, sessionLevels: Object }}
   */
  detect(htfCandles, state = null, options = {}) {
    const swingCfg = this.config.swing || {};
    const liqCfg = this.config.liquidity || {};
    const window = swingCfg.sensitivity || 2;
    const lookback = Math.min(htfCandles.length, swingCfg.lookbackBars || 48);

    if (htfCandles.length < Math.max(8, window * 2 + 2)) {
      return { pools: [], swings: { swingLows: [], swingHighs: [] }, sessionLevels: null };
    }

    const slice = htfCandles.slice(-lookback);
    const offset = htfCandles.length - slice.length;

    const swings =
      state?.swingLows?.length || state?.swingHighs?.length
        ? {
            swingLows: state.swingLows,
            swingHighs: state.swingHighs
          }
        : (() => {
            const raw = findSwingPoints(slice, window);
            return {
              swingLows: raw.swingLows.map(s => ({ ...s, index: offset + s.index })),
              swingHighs: raw.swingHighs.map(s => ({ ...s, index: offset + s.index }))
            };
          })();

    const atrVal = atr(htfCandles, this.config.displacement?.atrPeriod || 14);
    const eqTol = (swingCfg.equalToleranceAtrRatio || 0.08) * (atrVal || 0);

    /** @type {import('../types').LiquidityPool[]} */
    const pools = [];

    const lastLow = swings.swingLows[swings.swingLows.length - 1];
    const lastHigh = swings.swingHighs[swings.swingHighs.length - 1];
    if (lastLow) {
      pools.push({
        type: 'previous_swing_low',
        price: lastLow.price,
        time: lastLow.time,
        index: lastLow.index,
        side: 'sell_side',
        sweepCount: 0
      });
    }
    if (lastHigh) {
      pools.push({
        type: 'previous_swing_high',
        price: lastHigh.price,
        time: lastHigh.time,
        index: lastHigh.index,
        side: 'buy_side',
        sweepCount: 0
      });
    }

    const majorLookback = swingCfg.majorSwingLookback || 0;
    if (majorLookback > 0) {
      const majorLow =
        swings.swingLows[Math.max(0, swings.swingLows.length - 1 - Math.min(3, majorLookback))];
      const majorHigh =
        swings.swingHighs[Math.max(0, swings.swingHighs.length - 1 - Math.min(3, majorLookback))];
      if (majorLow && majorLow !== lastLow) {
        pools.push({
          type: 'major_swing_low',
          price: majorLow.price,
          time: majorLow.time,
          index: majorLow.index,
          side: 'sell_side',
          sweepCount: 0
        });
      }
      if (majorHigh && majorHigh !== lastHigh) {
        pools.push({
          type: 'major_swing_high',
          price: majorHigh.price,
          time: majorHigh.time,
          index: majorHigh.index,
          side: 'buy_side',
          sweepCount: 0
        });
      }
    }

    pools.push(...this._findEqualLevels(swings.swingHighs, 'equal_highs', 'buy_side', eqTol));
    pools.push(...this._findEqualLevels(swings.swingLows, 'equal_lows', 'sell_side', eqTol));

    let sessionLevels = state?.sessionLevels || computeSessionLevels(htfCandles, this.config.sessions);
    if (liqCfg.includeWeekly !== false && sessionLevels?._byDay) {
      const weekly = computeWeeklyLevels(sessionLevels._byDay);
      sessionLevels = { ...sessionLevels, ...weekly };
    }
    if (liqCfg.includeMonthly !== false && sessionLevels?._byDay) {
      const monthly = computeMonthlyLevels(sessionLevels._byDay);
      sessionLevels = { ...sessionLevels, ...monthly };
    }
    pools.push(...sessionPoolsFromLevels(sessionLevels));

    if (liqCfg.includeRoundLevels) {
      const last = htfCandles[htfCandles.length - 1];
      pools.push(
        ...roundPsychologicalPools(last.close, options.symbol || '', liqCfg.roundLevelStepMult || 1)
      );
    }

    if (liqCfg.includeTrendline) {
      pools.push(...this._trendlinePools(swings, htfCandles.length - 1));
    }

    return { pools, swings, sessionLevels };
  }

  /** @private */
  _trendlinePools(swings, lastIndex) {
    /** @type {import('../types').LiquidityPool[]} */
    const out = [];
    if (swings.swingHighs.length >= 2) {
      const a = swings.swingHighs[swings.swingHighs.length - 2];
      const b = swings.swingHighs[swings.swingHighs.length - 1];
      const slope = (b.price - a.price) / Math.max(1, b.index - a.index);
      const projected = b.price + slope * (lastIndex - b.index);
      if (Number.isFinite(projected)) {
        out.push({ type: 'trendline_high', price: projected, side: 'buy_side', sweepCount: 0 });
      }
    }
    if (swings.swingLows.length >= 2) {
      const a = swings.swingLows[swings.swingLows.length - 2];
      const b = swings.swingLows[swings.swingLows.length - 1];
      const slope = (b.price - a.price) / Math.max(1, b.index - a.index);
      const projected = b.price + slope * (lastIndex - b.index);
      if (Number.isFinite(projected)) {
        out.push({ type: 'trendline_low', price: projected, side: 'sell_side', sweepCount: 0 });
      }
    }
    return out;
  }

  /** @private */
  _findEqualLevels(swings, type, side, tolerance) {
    if (swings.length < 2 || tolerance <= 0) return [];
    /** @type {import('../types').LiquidityPool[]} */
    const out = [];
    const used = new Set();
    for (let i = swings.length - 1; i >= 1; i -= 1) {
      if (used.has(i)) continue;
      const cluster = [swings[i]];
      for (let j = i - 1; j >= 0; j -= 1) {
        if (Math.abs(swings[j].price - swings[i].price) <= tolerance) {
          cluster.push(swings[j]);
          used.add(j);
        }
      }
      if (cluster.length >= 2) {
        used.add(i);
        const price = cluster.reduce((s, x) => s + x.price, 0) / cluster.length;
        out.push({
          type,
          price,
          time: cluster[0].time,
          index: cluster[0].index,
          side,
          sweepCount: 0
        });
        break;
      }
    }
    return out;
  }
}

module.exports = { LiquidityDetector };
