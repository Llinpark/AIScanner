/**
 * LiquiditySweepDetector — sweep = trade beyond pool + close back (rejection).
 * Runs on HTF (15m). Records type, price, time, direction, sweep candle.
 */

class LiquiditySweepDetector {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Scan HTF candles after each pool's formation index for a rejection sweep.
   * Prefer the most recent valid sweep; reject pools already swept too many times.
   *
   * @param {import('../types').Candle[]} htfCandles
   * @param {import('../types').LiquidityPool[]} pools
   * @returns {import('../types').LiquiditySweep|null}
   */
  detect(htfCandles, pools) {
    if (!htfCandles.length || !pools?.length) return null;

    const maxSweeps = this.config.swing?.maxSweepsBeforeReject || 2;
    /** @type {import('../types').LiquiditySweep|null} */
    let best = null;

    for (const pool of pools) {
      let sweepCount = pool.sweepCount || 0;
      const start = Math.max(0, (pool.index ?? 0) + 1);

      for (let i = start; i < htfCandles.length; i += 1) {
        const c = htfCandles[i];
        const sweep = this._probeSweep(c, i, pool);
        if (!sweep) continue;

        sweepCount += 1;
        if (sweepCount > maxSweeps) {
          // Liquidity already hunted multiple times — skip this pool
          break;
        }

        // Keep the latest single-sweep event (first hunt is highest quality)
        if (sweepCount === 1) {
          best = sweep;
        }
      }

      pool.sweepCount = sweepCount;
    }

    // If the best pool was multi-swept beyond limit, invalidate
    if (best && (best.pool.sweepCount || 0) > maxSweeps) {
      return null;
    }

    return best;
  }

  /**
   * Detect sweeps only on the latest closed HTF bar (incremental path).
   * @param {import('../types').Candle[]} htfCandles
   * @param {import('../types').LiquidityPool[]} pools
   */
  detectOnLatestBar(htfCandles, pools) {
    if (htfCandles.length < 2 || !pools?.length) return null;
    const i = htfCandles.length - 1;
    const c = htfCandles[i];
    const maxSweeps = this.config.swing?.maxSweepsBeforeReject || 2;

    /** @type {import('../types').LiquiditySweep|null} */
    let hit = null;

    for (const pool of pools) {
      if ((pool.index ?? -1) >= i) continue;
      const sweep = this._probeSweep(c, i, pool);
      if (!sweep) continue;

      pool.sweepCount = (pool.sweepCount || 0) + 1;
      if (pool.sweepCount > maxSweeps) continue;
      hit = sweep;
    }

    return hit;
  }

  /**
   * @private
   * @param {import('../types').Candle} c
   * @param {number} i
   * @param {import('../types').LiquidityPool} pool
   * @returns {import('../types').LiquiditySweep|null}
   */
  _probeSweep(c, i, pool) {
    const level = pool.price;

    // Sell-side (lows): wick below level, close back above → bullish (long) setup
    if (pool.side === 'sell_side') {
      if (c.low < level && c.close > level) {
        return {
          direction: 'long',
          liquidityType: pool.type,
          level,
          sweepPrice: c.low,
          time: c.time,
          sweepIndex: i,
          sweepCandle: c,
          pool
        };
      }
    }

    // Buy-side (highs): wick above level, close back below → bearish (short) setup
    if (pool.side === 'buy_side') {
      if (c.high > level && c.close < level) {
        return {
          direction: 'short',
          liquidityType: pool.type,
          level,
          sweepPrice: c.high,
          time: c.time,
          sweepIndex: i,
          sweepCandle: c,
          pool
        };
      }
    }

    return null;
  }
}

module.exports = { LiquiditySweepDetector };
