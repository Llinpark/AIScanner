/**
 * TakeProfitEngine — multiple partial TPs → TP1 / TP2 / TP3.
 *
 * Default: Smart Liquidity Target Engine — detect direction-aligned SMC
 * objectives, score them, and only allow candidates that satisfy ALL of:
 *   1) Distance <= Maximum TP Distance (pips)
 *   2) Distance <= ATR Cap for the TP slot
 *   3) Probability Score >= Minimum Score
 * Then rank (highest score, nearer when close) and pick TP1–3 with
 * increasing distance. RR fallback only when no eligible liquidity remains.
 *
 * Legacy models: rr, previous_swing, nearest_liquidity, next_ob, manual_rr,
 * institutional / daytrading. dynamic_liquidity aliases smart scoring.
 */

const { atr, findSwingPoints, getPipSize } = require('../utils/candleMath');
const { FairValueGapDetector } = require('../detectors/FairValueGapDetector');
const {
  getTpProfile,
  SYSTEM_DEFAULT_TP_PROFILE,
  SCALPING_TP_PROFILE,
  DAY_TRADING_TP_PROFILE
} = require('../profiles');

/** @deprecated Prefer DEFAULT_SCORE_WEIGHTS; kept for admin/config migration. */
const DEFAULT_LIQUIDITY_PRIORITY = Object.freeze([
  'nearest_liquidity_pool',
  'equal_high_low',
  'swing_high_low',
  'pdh_pdl',
  'pwh_pwl',
  'untapped_fvg'
]);

const SCALP_ATR_CAPS = Object.freeze([...(SCALPING_TP_PROFILE.atrCaps || [0.7, 1.3, 2.0])]);
const DAY_ATR_CAPS = Object.freeze([...(DAY_TRADING_TP_PROFILE.atrCaps || [1.5, 2.5, 3.5])]);

/** System-default probability weights (fallback when profile missing). */
const DEFAULT_SCORE_WEIGHTS = Object.freeze({
  ...(SYSTEM_DEFAULT_TP_PROFILE.scoreWeights || {})
});

/** Default RR multiples used only when no eligible liquidity remains. */
const DEFAULT_RR_MULTIPLES = Object.freeze([1.5, 2, 3]);

/** Within this many score points, prefer the nearer target. */
const DEFAULT_SCORE_PROXIMITY = 5;

const EQUAL_TYPES = new Set(['equal_highs', 'equal_lows']);
const SWING_TYPES = new Set([
  'previous_swing_high',
  'previous_swing_low',
  'swing_high',
  'swing_low'
]);
const EXTERNAL_TYPES = new Set(['major_swing_high', 'major_swing_low', 'external_liquidity']);
const INTERNAL_TYPES = new Set([
  'asian_high',
  'asian_low',
  'london_high',
  'london_low',
  'ny_high',
  'ny_low',
  'round_psychological',
  'trendline_high',
  'trendline_low',
  'internal_liquidity',
  'nearest_liquidity_pool'
]);
const PD_TYPES = new Set(['pdh', 'pdl']);
const PW_TYPES = new Set(['pwh', 'pwl']);
const PM_TYPES = new Set(['pmh', 'pml']);
const FVG_TYPES = new Set(['untapped_fvg', 'fvg_boundary', 'fvg_ce']);
const OB_TYPES = new Set(['order_block', 'ob']);
const BREAKER_TYPES = new Set(['breaker_block', 'breaker']);
const MITIGATION_TYPES = new Set(['mitigation_block', 'mitigation']);

const SMART_MODELS = new Set([
  'smart_scoring',
  'smart_tp',
  'dynamic_liquidity',
  'dynamic'
]);

class TakeProfitEngine {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
    this.fvgDetector = new FairValueGapDetector(config);
  }

  /**
   * @param {Object} params
   * @param {import('../types').TradeDirection} params.direction
   * @param {number} params.entry
   * @param {number} params.risk
   * @param {import('../types').Candle[]} params.candles
   * @param {import('../types').LiquidityPool[]} [params.pools]
   * @param {number} [params.atrValue]
   * @param {string} [params.symbol]
   * @param {string} [params.htfBias]
   * @returns {{ take_profit_1: number, take_profit_2: number, take_profit_3: number, rr: number, model: string }}
   */
  compute({ direction, entry, risk, candles, pools = [], atrValue = null, symbol = '', htfBias = null }) {
    const tpCfg = this.config.takeProfit || {};
    const model = String(tpCfg.model || 'smart_scoring').toLowerCase();
    const multiples =
      model === 'manual_rr'
        ? tpCfg.manualRr || [...DEFAULT_RR_MULTIPLES]
        : tpCfg.rrMultiples || [...DEFAULT_RR_MULTIPLES];

    const legacyModels = new Set([
      'rr',
      'manual_rr',
      'previous_swing',
      'nearest_liquidity',
      'next_ob',
      'institutional',
      'daytrading'
    ]);

    const useSmart =
      this._isSmartScoringEnabled(tpCfg) &&
      (SMART_MODELS.has(model) || !legacyModels.has(model));

    if (useSmart) {
      return this._fromSmartScoring({
        direction,
        entry,
        risk,
        candles,
        pools,
        atrValue,
        symbol,
        multiples,
        htfBias
      });
    }

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

  /** @private */
  _isSmartScoringEnabled(tpCfg) {
    // Either flag can disable; both default on for the smart path
    if (tpCfg.enableSmartTpScoring === false) return false;
    if (tpCfg.enableDynamicTp === false) return false;
    return true;
  }

  /**
   * Smart Liquidity Target Engine.
   * Every competing candidate must satisfy Max Distance + ATR Cap + Min Score.
   * @private
   */
  _fromSmartScoring({ direction, entry, risk, candles, pools, atrValue, symbol, multiples, htfBias }) {
    const tpCfg = this.config.takeProfit || {};
    const atrCaps = this._resolveAtrCaps(tpCfg);
    const weights = this._resolveScoreWeights(tpCfg);
    const minScore =
      Number.isFinite(Number(tpCfg.minScore)) && Number(tpCfg.minScore) >= 0
        ? Number(tpCfg.minScore)
        : 0;
    const scoreProximity =
      Number.isFinite(Number(tpCfg.scoreProximity)) && Number(tpCfg.scoreProximity) >= 0
        ? Number(tpCfg.scoreProximity)
        : DEFAULT_SCORE_PROXIMITY;
    const allowRrFallback = tpCfg.allowRrFallback !== false;
    const maxTpDistancePips =
      Number.isFinite(Number(tpCfg.maxTpDistancePips)) && Number(tpCfg.maxTpDistancePips) > 0
        ? Number(tpCfg.maxTpDistancePips)
        : null;

    const resolvedAtr =
      Number.isFinite(atrValue) && atrValue > 0
        ? atrValue
        : atr(candles, this.config.displacement?.atrPeriod || 14) || 0;

    const maxAtrMult =
      Number.isFinite(Number(tpCfg.maxAtrMultiplier)) && Number(tpCfg.maxAtrMultiplier) > 0
        ? Number(tpCfg.maxAtrMultiplier)
        : atrCaps[atrCaps.length - 1] || 2.0;
    const maxAtrDist = resolvedAtr > 0 ? resolvedAtr * maxAtrMult : null;

    let maxPipDist = null;
    if (maxTpDistancePips != null) {
      const pip = getPipSize(symbol);
      if (pip > 0) maxPipDist = maxTpDistancePips * pip;
    }

    // Collect liquidity / ATR magnets only — RR never competes in the scored pool
    const candidates = this._collectScoredTargets({
      direction,
      entry,
      candles,
      pools,
      weights,
      atrValue: resolvedAtr,
      risk,
      multiples,
      includeRrFallback: false
    });

    // Global eligibility: direction + min score + max pip distance + overall ATR ceiling
    const eligible = this._filterTargets({
      candidates,
      direction,
      entry,
      maxPipDist,
      maxAtrDist,
      minScore,
      htfBias
    });

    // Strategy profile gate: e.g. scalp ignores PWH/PWL/PMH/PML while nearby targets exist
    const gated = this._applyDeferredLiquidityGate(eligible, tpCfg);
    const ranked = this._rankTargets(gated, scoreProximity);

    const selected = [];
    const sources = [];
    let prevDist = 0;

    for (let i = 0; i < 3; i += 1) {
      const slotAtrCap =
        resolvedAtr > 0 ? resolvedAtr * (atrCaps[i] || atrCaps[atrCaps.length - 1] || maxAtrMult) : null;
      const pick = this._selectNextTarget({
        direction,
        entry,
        ranked,
        used: selected,
        prevDist,
        slotAtrCap,
        maxPipDist,
        maxAtrDist,
        slot: i,
        risk,
        multiples,
        allowRrFallback,
        weights,
        atrValue: resolvedAtr
      });
      selected.push(pick.price);
      sources.push(pick);
      prevDist = Math.abs(pick.price - entry);
    }

    let [t1, t2, t3] = selected;
    const hardCap = this._effectiveCap(null, maxPipDist, maxAtrDist);
    const clampToCap = price => {
      if (hardCap == null) return price;
      const dist = Math.abs(price - entry);
      if (dist <= hardCap + 1e-12) return price;
      return direction === 'long' ? entry + hardCap : entry - hardCap;
    };
    if (direction === 'long') {
      if (t2 <= t1) t2 = clampToCap(this._rrPrice(direction, entry, risk, multiples[1] || 2));
      if (t2 <= t1 && hardCap != null && hardCap > Math.abs(t1 - entry)) t2 = entry + hardCap;
      if (t3 <= t2) t3 = clampToCap(this._rrPrice(direction, entry, risk, multiples[2] || 3));
      if (t3 <= t2 && hardCap != null && hardCap > Math.abs(t2 - entry)) t3 = entry + hardCap;
    } else {
      if (t2 >= t1) t2 = clampToCap(this._rrPrice(direction, entry, risk, multiples[1] || 2));
      if (t2 >= t1 && hardCap != null && hardCap > Math.abs(t1 - entry)) t2 = entry - hardCap;
      if (t3 >= t2) t3 = clampToCap(this._rrPrice(direction, entry, risk, multiples[2] || 3));
      if (t3 >= t2 && hardCap != null && hardCap > Math.abs(t2 - entry)) t3 = entry - hardCap;
    }

    // Final hard-cap enforcement (never emit beyond max pip / max ATR)
    t1 = clampToCap(t1);
    t2 = clampToCap(t2);
    t3 = clampToCap(t3);

    return {
      take_profit_1: t1,
      take_profit_2: t2,
      take_profit_3: t3,
      rr: risk > 0 ? Math.abs(t3 - entry) / risk : multiples[2] || 3,
      model: 'smart_scoring',
      sources,
      atrCaps,
      atr: resolvedAtr,
      scoreWeights: weights,
      maxTpDistancePips,
      maxPipDist
    };
  }

  /**
   * Scalp (and similar) profiles defer weekly/monthly liquidity until no nearby
   * non-deferred candidates remain. Day profiles leave deferredCategories empty.
   * @private
   */
  _applyDeferredLiquidityGate(eligible, tpCfg) {
    const deferred = Array.isArray(tpCfg.deferredLiquidityCategories)
      ? tpCfg.deferredLiquidityCategories.map(String)
      : [];
    if (!deferred.length || !eligible.length) return eligible;
    const deferredSet = new Set(deferred);
    const nearby = eligible.filter(c => !deferredSet.has(c.category));
    return nearby.length ? nearby : eligible;
  }

  /** @private */
  _resolveScoreWeights(tpCfg) {
    const profileKey =
      tpCfg.profileId || this.config.id || this.config.takeProfit?.profileId || '';
    let profileWeights = DEFAULT_SCORE_WEIGHTS;
    try {
      profileWeights = getTpProfile(profileKey).scoreWeights || DEFAULT_SCORE_WEIGHTS;
    } catch (_) {
      profileWeights = DEFAULT_SCORE_WEIGHTS;
    }
    const base = { ...profileWeights };
    const custom = tpCfg.scoreWeights && typeof tpCfg.scoreWeights === 'object' ? tpCfg.scoreWeights : {};
    for (const key of Object.keys(base)) {
      if (custom[key] !== undefined && Number.isFinite(Number(custom[key]))) {
        base[key] = Number(custom[key]);
      }
    }
    // Ensure all known keys exist even if profile omitted some
    for (const key of Object.keys(DEFAULT_SCORE_WEIGHTS)) {
      if (base[key] === undefined) base[key] = DEFAULT_SCORE_WEIGHTS[key];
    }
    // Alias keys from admin / legacy naming
    const aliases = {
      internalLiquidity: 'internal_liquidity',
      externalLiquidity: 'external_liquidity',
      equalHighLow: 'equal_high_low',
      swingHighLow: 'swing_high_low',
      fvg: 'untapped_fvg',
      untappedFvg: 'untapped_fvg',
      orderBlock: 'order_block',
      orderBlocks: 'order_block',
      breakerBlock: 'breaker_block',
      breakerBlocks: 'breaker_block',
      mitigationBlock: 'mitigation_block',
      mitigationBlocks: 'mitigation_block',
      pdhPdl: 'pdh_pdl',
      pwhPwl: 'pwh_pwl',
      pmhPml: 'pmh_pml',
      atrProjection: 'atr_projection',
      rrFallback: 'rr_fallback',
      // legacy hierarchy category name
      nearest_liquidity_pool: 'internal_liquidity'
    };
    for (const [from, to] of Object.entries(aliases)) {
      if (custom[from] !== undefined && Number.isFinite(Number(custom[from]))) {
        base[to] = Number(custom[from]);
      }
    }
    return base;
  }

  /** @private */
  _resolveAtrCaps(tpCfg) {
    if (Array.isArray(tpCfg.atrCaps) && tpCfg.atrCaps.length >= 3) {
      const caps = tpCfg.atrCaps.map(Number).filter(n => Number.isFinite(n) && n > 0).slice(0, 3);
      if (caps.length >= 3) return caps;
    }
    if (Number.isFinite(Number(tpCfg.maxAtrMultiplier)) && Number(tpCfg.maxAtrMultiplier) > 0) {
      const m = Number(tpCfg.maxAtrMultiplier);
      return [m * 0.35, m * 0.65, m];
    }
    try {
      const profileKey =
        tpCfg.profileId || tpCfg.profile || this.config.id || this.config.htfTimeframe || '';
      const caps = getTpProfile(profileKey).atrCaps;
      if (Array.isArray(caps) && caps.length >= 3) return [...caps];
    } catch (_) {
      // fall through
    }
    const profile = String(tpCfg.profileId || tpCfg.profile || this.config.id || '').toLowerCase();
    if (profile.includes('day') || this.config.htfTimeframe === '4h') {
      return [...DAY_ATR_CAPS];
    }
    if (profile.includes('scalp') || this.config.htfTimeframe === '15m') {
      return [...SCALP_ATR_CAPS];
    }
    if (String(this.config.id || '').includes('daytrading')) return [...DAY_ATR_CAPS];
    return [...(SYSTEM_DEFAULT_TP_PROFILE.atrCaps || SCALP_ATR_CAPS)];
  }

  /**
   * Combined hard distance ceiling for a slot (min of ATR slot / max ATR / max pips).
   * @private
   */
  _effectiveCap(slotAtrCap, maxPipDist, maxAtrDist) {
    const parts = [slotAtrCap, maxPipDist, maxAtrDist].filter(d => d != null && d > 0);
    return parts.length ? Math.min(...parts) : null;
  }

  /**
   * @private
   * @returns {Array<{ price: number, category: string, type: string, distance: number, score: number }>}
   */
  _collectScoredTargets({
    direction,
    entry,
    candles,
    pools,
    weights,
    atrValue,
    risk,
    multiples,
    includeRrFallback = false
  }) {
    const side = direction === 'long' ? 'buy_side' : 'sell_side';
    /** @type {Array<{ price: number, category: string, type: string, distance: number, score: number }>} */
    const out = [];
    const seen = new Set();

    const push = (price, category, type) => {
      if (!Number.isFinite(price)) return;
      if (direction === 'long' ? !(price > entry) : !(price < entry)) return;
      const key = `${category}:${Number(price).toFixed(8)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const distance = Math.abs(price - entry);
      const score = Number(weights[category]) || 0;
      out.push({ price, category, type, distance, score });
    };

    for (const pool of pools || []) {
      if (pool.side && pool.side !== side) continue;
      const category = this._categorizePoolType(pool.type);
      push(pool.price, category, pool.type || category);
    }

    const { swingHighs, swingLows } = findSwingPoints(
      candles,
      this.config.swing?.sensitivity || 2
    );
    const swings = direction === 'long' ? swingHighs : swingLows;
    for (const s of swings) {
      push(s.price, 'swing_high_low', direction === 'long' ? 'swing_high' : 'swing_low');
    }

    for (const fvg of this._findUntappedFvgTargets(candles, direction, entry)) {
      push(fvg.price, 'untapped_fvg', fvg.type);
    }

    for (const ob of this._findOrderBlockTargets(candles, direction, entry)) {
      push(ob.price, ob.category, ob.type);
    }

    // Synthetic ATR projection levels (low-weight magnets; still must pass filters)
    if (atrValue > 0 && (weights.atr_projection || 0) > 0) {
      const caps = this._resolveAtrCaps(this.config.takeProfit || {});
      for (let i = 0; i < 3; i += 1) {
        const dist = atrValue * (caps[i] || caps[caps.length - 1] || 1);
        const price = direction === 'long' ? entry + dist : entry - dist;
        push(price, 'atr_projection', `atr_cap_${i + 1}`);
      }
    }

    // RR candidates are never mixed into competition unless explicitly requested
    if (includeRrFallback && risk > 0 && (weights.rr_fallback || 0) > 0) {
      for (let i = 0; i < 3; i += 1) {
        push(
          this._rrPrice(direction, entry, risk, multiples[i] || multiples[0] || 1.5),
          'rr_fallback',
          `rr_${i + 1}`
        );
      }
    }

    return out;
  }

  /** @private */
  _categorizePoolType(type) {
    const t = String(type || '');
    if (EQUAL_TYPES.has(t)) return 'equal_high_low';
    if (EXTERNAL_TYPES.has(t)) return 'external_liquidity';
    if (SWING_TYPES.has(t)) return 'swing_high_low';
    if (PD_TYPES.has(t)) return 'pdh_pdl';
    if (PW_TYPES.has(t)) return 'pwh_pwl';
    if (PM_TYPES.has(t)) return 'pmh_pml';
    if (FVG_TYPES.has(t) || t.startsWith('fvg_')) return 'untapped_fvg';
    if (OB_TYPES.has(t)) return 'order_block';
    if (BREAKER_TYPES.has(t)) return 'breaker_block';
    if (MITIGATION_TYPES.has(t)) return 'mitigation_block';
    if (INTERNAL_TYPES.has(t)) return 'internal_liquidity';
    // Unknown session / pool types → internal liquidity
    return 'internal_liquidity';
  }

  /**
   * Opposing / ahead FVGs act as liquidity magnets for TP.
   * @private
   */
  _findUntappedFvgTargets(candles, direction, entry) {
    if (!candles || candles.length < 5) return [];
    const lookback = Math.min(candles.length - 1, (this.config.fvg?.lookbackBars || 18) + 20);
    const start = Math.max(2, candles.length - 1 - lookback);
    /** @type {Array<{ price: number, type: string }>} */
    const targets = [];

    for (let i = start; i < candles.length; i += 1) {
      const opposite = direction === 'long' ? 'short' : 'long';
      const fvg = this.fvgDetector.detectTriplet(
        candles[i - 2],
        candles[i - 1],
        candles[i],
        i,
        candles,
        opposite
      );
      if (!fvg) continue;

      if (direction === 'long') {
        const later = candles.slice(i + 1);
        const filled = later.some(c => c.low <= fvg.gapBottom);
        if (filled) continue;
        if (fvg.gapBottom > entry) targets.push({ price: fvg.gapBottom, type: 'fvg_boundary' });
        if (fvg.ce > entry) targets.push({ price: fvg.ce, type: 'fvg_ce' });
      } else {
        const later = candles.slice(i + 1);
        const filled = later.some(c => c.high >= fvg.gapTop);
        if (filled) continue;
        if (fvg.gapTop < entry) targets.push({ price: fvg.gapTop, type: 'fvg_boundary' });
        if (fvg.ce < entry) targets.push({ price: fvg.ce, type: 'fvg_ce' });
      }
    }
    return targets;
  }

  /**
   * Heuristic OB / breaker / mitigation targets ahead of entry.
   * Long: bearish (supply) structure above entry. Short: bullish (demand) below.
   * @private
   */
  _findOrderBlockTargets(candles, direction, entry) {
    if (!candles || candles.length < 8) return [];
    const lookback = Math.min(candles.length - 1, 40);
    const start = Math.max(1, candles.length - 1 - lookback);
    /** @type {Array<{ price: number, category: string, type: string }>} */
    const targets = [];

    for (let i = start; i < candles.length - 2; i += 1) {
      const c = candles[i];
      const bullish = c.close >= c.open;
      const next = candles[i + 1];
      const later = candles.slice(i + 1);

      if (direction === 'long' && !bullish) {
        const obHigh = Math.max(c.open, c.close);
        const obLow = Math.min(c.open, c.close);
        if (!(obHigh > entry)) continue;

        const broken = later.some(x => x.close > obHigh);
        const mitigated = later.some(x => x.low <= obLow);

        if (broken && !mitigated) {
          targets.push({ price: obHigh, category: 'breaker_block', type: 'breaker_block' });
        } else if (!broken && mitigated && next && next.close > c.high) {
          targets.push({ price: obHigh, category: 'mitigation_block', type: 'mitigation_block' });
        } else if (!broken) {
          targets.push({ price: obHigh, category: 'order_block', type: 'order_block' });
        }
      }

      if (direction === 'short' && bullish) {
        const obHigh = Math.max(c.open, c.close);
        const obLow = Math.min(c.open, c.close);
        if (!(obLow < entry)) continue;

        const broken = later.some(x => x.close < obLow);
        const mitigated = later.some(x => x.high >= obHigh);

        if (broken && !mitigated) {
          targets.push({ price: obLow, category: 'breaker_block', type: 'breaker_block' });
        } else if (!broken && mitigated && next && next.close < c.low) {
          targets.push({ price: obLow, category: 'mitigation_block', type: 'mitigation_block' });
        } else if (!broken) {
          targets.push({ price: obLow, category: 'order_block', type: 'order_block' });
        }
      }
    }

    // Keep a few nearest of each category to avoid flooding
    const byCat = new Map();
    for (const t of targets) {
      const list = byCat.get(t.category) || [];
      list.push(t);
      byCat.set(t.category, list);
    }
    const trimmed = [];
    for (const list of byCat.values()) {
      list.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
      trimmed.push(...list.slice(0, 3));
    }
    return trimmed;
  }

  /**
   * Strict eligibility: wrong-side / below min score / beyond max pips / beyond max ATR → reject.
   * No soft keep for ATR/RR synthetics beyond limits.
   * @private
   */
  _filterTargets({ candidates, direction, entry, maxPipDist, maxAtrDist, minScore, htfBias }) {
    const bias = String(htfBias || '').toLowerCase();
    const biasOpposes =
      (bias === 'bullish' || bias === 'long' || bias === 'buy') && direction === 'short'
        ? true
        : (bias === 'bearish' || bias === 'short' || bias === 'sell') && direction === 'long';

    return candidates.filter(c => {
      if (!Number.isFinite(c.price)) return false;
      if (direction === 'long' ? !(c.price > entry) : !(c.price < entry)) return false;
      if (c.score < minScore) return false;
      // Structural targets that oppose HTF bias are dropped; RR fills later if needed
      if (biasOpposes && c.category !== 'atr_projection') {
        return false;
      }
      if (maxPipDist != null && c.distance > maxPipDist + 1e-12) return false;
      if (maxAtrDist != null && c.distance > maxAtrDist + 1e-12) return false;
      return true;
    });
  }

  /**
   * Rank by score desc; within scoreProximity always prefer nearer.
   * @private
   */
  _rankTargets(candidates, scoreProximity) {
    return [...candidates].sort((a, b) => {
      if (Math.abs(a.score - b.score) <= scoreProximity) {
        return a.distance - b.distance || b.score - a.score;
      }
      return b.score - a.score || a.distance - b.distance;
    });
  }

  /**
   * Pick next TP from ranked eligible list.
   * Candidate must be farther than previous TP and within slot ATR + max pip + max ATR.
   * RR fallback only when no liquidity remains for this slot.
   * @private
   */
  _selectNextTarget({
    direction,
    entry,
    ranked,
    used,
    prevDist,
    slotAtrCap,
    maxPipDist,
    maxAtrDist,
    slot,
    risk,
    multiples,
    allowRrFallback,
    weights,
    atrValue
  }) {
    const usedPrices = used;
    const notUsed = c => !usedPrices.some(u => Math.abs(u - c.price) < 1e-12);
    const farther = c => c.distance > prevDist + 1e-12;
    const effectiveCap = this._effectiveCap(slotAtrCap, maxPipDist, maxAtrDist);

    const withinAllGates = ranked.filter(c => {
      if (!notUsed(c) || !farther(c)) return false;
      if (effectiveCap != null && c.distance > effectiveCap + 1e-12) return false;
      return true;
    });

    if (withinAllGates.length) {
      const best = withinAllGates[0];
      return {
        price: best.price,
        source: best.category,
        type: best.type,
        score: best.score,
        capped: false
      };
    }

    // No eligible liquidity for this slot → RR fallback only
    if (allowRrFallback !== false) {
      return this._rrFallbackPick({
        direction,
        entry,
        risk,
        multiples,
        slot,
        prevDist,
        effectiveCap,
        weights,
        atrValue
      });
    }

    // Last resort when RR disabled: step beyond previous by ATR/risk
    const step =
      risk > 0
        ? risk * (multiples[slot] || 1.5)
        : atrValue > 0
          ? atrValue * 0.5
          : Math.abs(entry) * 0.001;
    let dist = prevDist + step;
    if (effectiveCap != null && dist > effectiveCap) {
      dist = Math.max(prevDist + step * 0.25, Math.min(effectiveCap, prevDist + step));
      if (dist <= prevDist && effectiveCap > prevDist) dist = effectiveCap;
    }
    const price = direction === 'long' ? entry + dist : entry - dist;
    return {
      price,
      source: 'rr_fallback',
      type: 'rr',
      score: weights.rr_fallback || 5,
      capped: false
    };
  }

  /**
   * Build an RR-based TP for a slot, respecting increasing distance and hard caps.
   * @private
   */
  _rrFallbackPick({
    direction,
    entry,
    risk,
    multiples,
    slot,
    prevDist,
    effectiveCap,
    weights,
    atrValue
  }) {
    let price = this._rrPrice(direction, entry, risk, multiples[slot] || multiples[0] || 1.5);
    let dist = Math.abs(price - entry);

    if (effectiveCap != null && dist > effectiveCap) {
      price = direction === 'long' ? entry + effectiveCap : entry - effectiveCap;
      dist = effectiveCap;
    }

    if (dist <= prevDist) {
      const step =
        risk > 0
          ? risk * (multiples[slot] || 1.5)
          : atrValue > 0
            ? atrValue * 0.35
            : Math.abs(entry) * 0.001;
      let nextDist = prevDist + step;
      if (effectiveCap != null && nextDist > effectiveCap) {
        // Never exceed the hard cap (max pips / ATR). If already at the cap,
        // stay there rather than nudging beyond.
        nextDist = effectiveCap;
      }
      // If still not farther (cap == prevDist), keep a microscopic step only when uncapped
      if (nextDist <= prevDist && effectiveCap == null) {
        nextDist = prevDist + step * 0.1;
      }
      price = direction === 'long' ? entry + nextDist : entry - nextDist;
    }

    return {
      price,
      source: 'rr_fallback',
      type: 'rr',
      score: weights.rr_fallback || 5,
      capped: false
    };
  }

  /**
   * Daytrading multi-target map (legacy institutional):
   * TP1 nearest swing · TP2 PDH/PDL · TP3 PWH/PWL
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

    const pdTarget = direction === 'long' ? poolPrice('pdh') : poolPrice('pdl');
    const pwTarget = direction === 'long' ? poolPrice('pwh') : poolPrice('pwl');

    const valid = p =>
      Number.isFinite(p) && (direction === 'long' ? p > entry : p < entry);

    const t1 = swings[0] || this._rrPrice(direction, entry, risk, multiples[0] || 1.5);
    let t2 = valid(pdTarget) ? pdTarget : swings[1] || this._rrPrice(direction, entry, risk, multiples[1] || 2);
    let t3 = valid(pwTarget) ? pwTarget : swings[2] || this._rrPrice(direction, entry, risk, multiples[2] || 3);

    if (direction === 'long') {
      if (t2 <= t1) t2 = this._rrPrice(direction, entry, risk, multiples[1] || 2);
      if (t3 <= t2) t3 = this._rrPrice(direction, entry, risk, multiples[2] || 3);
    } else {
      if (t2 >= t1) t2 = this._rrPrice(direction, entry, risk, multiples[1] || 2);
      if (t3 >= t2) t3 = this._rrPrice(direction, entry, risk, multiples[2] || 3);
    }

    const side = direction === 'long' ? 'buy_side' : 'sell_side';
    const nextLiq = pools
      .filter(p => p.side === side && !['pdh', 'pdl', 'pwh', 'pwl', 'pmh', 'pml'].includes(p.type))
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
      rr: risk > 0 ? Math.abs(t3 - entry) / risk : multiples[2] || 3,
      model: 'institutional',
      partials
    };
  }

  /** @private */
  _fromRr(direction, entry, risk, multiples, modelName) {
    const [r1, r2, r3] = [
      multiples[0] || 1.5,
      multiples[1] || multiples[0] * 1.5 || 2,
      multiples[2] || multiples[0] * 2 || 3
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
      const t2 = targets[1] || this._rrPrice(direction, entry, risk, multiples[1] || 2);
      const t3 = targets[2] || this._rrPrice(direction, entry, risk, multiples[2] || 3);
      return {
        take_profit_1: t1,
        take_profit_2: t2,
        take_profit_3: t3,
        rr: risk > 0 ? Math.abs(t3 - entry) / risk : multiples[2] || 3,
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
    const t2 = levels[1] || this._rrPrice(direction, entry, risk, multiples[1] || 2);
    const t3 = levels[2] || this._rrPrice(direction, entry, risk, multiples[2] || 3);
    return {
      take_profit_1: t1,
      take_profit_2: t2,
      take_profit_3: t3,
      rr: risk > 0 ? Math.abs(t3 - entry) / risk : multiples[2] || 3,
      model: 'nearest_liquidity'
    };
  }

  /** @private */
  _fromOrderBlockProxy(direction, entry, candles, multiples, risk) {
    for (let i = candles.length - 2; i >= Math.max(0, candles.length - 30); i -= 1) {
      const c = candles[i];
      const bullish = c.close >= c.open;
      if (direction === 'long' && !bullish) {
        const t1 = Math.max(c.open, c.close);
        if (t1 > entry) {
          return {
            take_profit_1: t1,
            take_profit_2: this._rrPrice(direction, entry, risk, multiples[1] || 2),
            take_profit_3: this._rrPrice(direction, entry, risk, multiples[2] || 3),
            rr: multiples[2] || 3,
            model: 'next_ob'
          };
        }
      }
      if (direction === 'short' && bullish) {
        const t1 = Math.min(c.open, c.close);
        if (t1 < entry) {
          return {
            take_profit_1: t1,
            take_profit_2: this._rrPrice(direction, entry, risk, multiples[1] || 2),
            take_profit_3: this._rrPrice(direction, entry, risk, multiples[2] || 3),
            rr: multiples[2] || 3,
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

module.exports = {
  TakeProfitEngine,
  DEFAULT_LIQUIDITY_PRIORITY,
  DEFAULT_SCORE_WEIGHTS,
  DEFAULT_SCORE_PROXIMITY,
  DEFAULT_RR_MULTIPLES,
  SCALP_ATR_CAPS,
  DAY_ATR_CAPS
};
