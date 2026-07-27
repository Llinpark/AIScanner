/**
 * TakeProfitEngine — multiple partial TPs → TP1 / TP2 / TP3.
 * Models: rr (2R/3R/4R default), previous_swing, nearest_liquidity, next_ob, manual_rr.
 */

const { findSwingPoints } = require('../utils/candleMath');

class TakeProfitEngine {
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
   * @param {number} params.risk
   * @param {import('../types').Candle[]} params.candles
   * @param {import('../types').LiquidityPool[]} [params.pools]
   * @returns {{ take_profit_1: number, take_profit_2: number, take_profit_3: number, rr: number, model: string }}
   */
  compute({ direction, entry, risk, candles, pools = [] }) {
    const model = (this.config.takeProfit?.model || 'rr').toLowerCase();
    const multiples =
      model === 'manual_rr'
        ? this.config.takeProfit?.manualRr || [1.5, 2.5, 4]
        : this.config.takeProfit?.rrMultiples || [2, 3, 4];

    if (model === 'previous_swing') {
      const tps = this._fromSwings(direction, entry, candles, multiples, risk);
      if (tps) return tps;
    }

    if (model === 'nearest_liquidity') {
      const tps = this._fromLiquidity(direction, entry, pools, multiples, risk);
      if (tps) return tps;
    }

    if (model === 'next_ob') {
      const tps = this._fromOrderBlockProxy(direction, entry, candles, multiples, risk);
      if (tps) return tps;
    }

    if (model === 'institutional' || model === 'daytrading') {
      const tps = this._fromInstitutional(direction, entry, risk, candles, pools, multiples);
      if (tps) return tps;
    }

    return this._fromRr(direction, entry, risk, multiples, model === 'manual_rr' ? 'manual_rr' : 'rr');
  }

  /**
   * Daytrading multi-target map (TV delivers TP1–3):
   * TP1 nearest swing · TP2 PDH/PDL · TP3 PWH/PWL
   * Extra targets kept in `partials` for diagnostics (TP4 liquidity, TP5–7 RR).
   * @private
   */
  _fromInstitutional(direction, entry, risk, candles, pools, multiples) {
    const { swingHighs, swingLows } = findSwingPoints(candles, this.config.swing?.sensitivity || 2);
    const swings =
      direction === 'long'
        ? swingHighs.map(s => s.price).filter(p => p > entry)
        : swingLows.map(s => s.price).filter(p => p < entry);
    swings.sort((a, b) => (direction === 'long' ? a - b : b - a));

    const poolPrice = type => {
      const hit = pools.find(p => p.type === type);
      return hit?.price;
    };

    const pdTarget =
      direction === 'long' ? poolPrice('pdh') : poolPrice('pdl');
    const pwTarget =
      direction === 'long' ? poolPrice('pwh') : poolPrice('pwl');

    const valid = p =>
      Number.isFinite(p) && (direction === 'long' ? p > entry : p < entry);

    const t1 = swings[0] || this._rrPrice(direction, entry, risk, multiples[0] || 2);
    let t2 = valid(pdTarget) ? pdTarget : swings[1] || this._rrPrice(direction, entry, risk, multiples[1] || 3);
    let t3 = valid(pwTarget) ? pwTarget : swings[2] || this._rrPrice(direction, entry, risk, multiples[2] || 4);

    // Ensure monotonic TP ladder
    if (direction === 'long') {
      if (t2 <= t1) t2 = this._rrPrice(direction, entry, risk, multiples[1] || 3);
      if (t3 <= t2) t3 = this._rrPrice(direction, entry, risk, multiples[2] || 4);
    } else {
      if (t2 >= t1) t2 = this._rrPrice(direction, entry, risk, multiples[1] || 3);
      if (t3 >= t2) t3 = this._rrPrice(direction, entry, risk, multiples[2] || 4);
    }

    const side = direction === 'long' ? 'buy_side' : 'sell_side';
    const nextLiq = pools
      .filter(p => p.side === side && !['pdh', 'pdl', 'pwh', 'pwl'].includes(p.type))
      .map(p => p.price)
      .filter(p => (direction === 'long' ? p > t3 : p < t3))
      .sort((a, b) => (direction === 'long' ? a - b : b - a))[0];

    const partials = {
      tp4_next_liquidity: nextLiq || this._rrPrice(direction, entry, risk, 2.5),
      tp5_2r: this._rrPrice(direction, entry, risk, 2),
      tp6_3r: this._rrPrice(direction, entry, risk, 3),
      tp7_4r: this._rrPrice(direction, entry, risk, 4)
    };

    return {
      take_profit_1: t1,
      take_profit_2: t2,
      take_profit_3: t3,
      rr: risk > 0 ? Math.abs(t3 - entry) / risk : multiples[2] || 4,
      model: 'institutional',
      partials
    };
  }

  /** @private */
  _fromRr(direction, entry, risk, multiples, modelName) {
    const [r1, r2, r3] = [
      multiples[0] || 2,
      multiples[1] || multiples[0] * 1.5 || 3,
      multiples[2] || multiples[0] * 2 || 4
    ];
    const sign = direction === 'long' ? 1 : -1;
    return {
      take_profit_1: entry + sign * risk * r1,
      take_profit_2: entry + sign * risk * r2,
      take_profit_3: entry + sign * risk * r3,
      rr: r3,
      model: modelName
    };
  }

  /** @private */
  _fromSwings(direction, entry, candles, multiples, risk) {
    const { swingHighs, swingLows } = findSwingPoints(candles, this.config.swing?.sensitivity || 2);
    const targets =
      direction === 'long'
        ? swingHighs.map(s => s.price).filter(p => p > entry)
        : swingLows.map(s => s.price).filter(p => p < entry);

    targets.sort((a, b) => (direction === 'long' ? a - b : b - a));

    if (targets.length >= 1) {
      const t1 = targets[0];
      const t2 = targets[1] || this._rrPrice(direction, entry, risk, multiples[1] || 3);
      const t3 = targets[2] || this._rrPrice(direction, entry, risk, multiples[2] || 4);
      return {
        take_profit_1: t1,
        take_profit_2: t2,
        take_profit_3: t3,
        rr: risk > 0 ? Math.abs(t3 - entry) / risk : multiples[2] || 4,
        model: 'previous_swing'
      };
    }
    return null;
  }

  /** @private */
  _fromLiquidity(direction, entry, pools, multiples, risk) {
    const side = direction === 'long' ? 'buy_side' : 'sell_side';
    const levels = pools
      .filter(p => p.side === side)
      .map(p => p.price)
      .filter(p => (direction === 'long' ? p > entry : p < entry));

    levels.sort((a, b) => (direction === 'long' ? a - b : b - a));
    if (!levels.length) return null;

    const t1 = levels[0];
    const t2 = levels[1] || this._rrPrice(direction, entry, risk, multiples[1] || 3);
    const t3 = levels[2] || this._rrPrice(direction, entry, risk, multiples[2] || 4);
    return {
      take_profit_1: t1,
      take_profit_2: t2,
      take_profit_3: t3,
      rr: risk > 0 ? Math.abs(t3 - entry) / risk : multiples[2] || 4,
      model: 'nearest_liquidity'
    };
  }

  /** @private */
  _fromOrderBlockProxy(direction, entry, candles, multiples, risk) {
    // Last candle with opposing close before latest bar — crude OB proxy
    for (let i = candles.length - 2; i >= Math.max(0, candles.length - 30); i -= 1) {
      const c = candles[i];
      const bullish = c.close >= c.open;
      if (direction === 'long' && !bullish) {
        const t1 = Math.max(c.open, c.close);
        if (t1 > entry) {
          return {
            take_profit_1: t1,
            take_profit_2: this._rrPrice(direction, entry, risk, multiples[1] || 3),
            take_profit_3: this._rrPrice(direction, entry, risk, multiples[2] || 4),
            rr: multiples[2] || 4,
            model: 'next_ob'
          };
        }
      }
      if (direction === 'short' && bullish) {
        const t1 = Math.min(c.open, c.close);
        if (t1 < entry) {
          return {
            take_profit_1: t1,
            take_profit_2: this._rrPrice(direction, entry, risk, multiples[1] || 3),
            take_profit_3: this._rrPrice(direction, entry, risk, multiples[2] || 4),
            rr: multiples[2] || 4,
            model: 'next_ob'
          };
        }
      }
    }
    return null;
  }

  /** @private */
  _rrPrice(direction, entry, risk, r) {
    const sign = direction === 'long' ? 1 : -1;
    return entry + sign * risk * r;
  }
}

module.exports = { TakeProfitEngine };
