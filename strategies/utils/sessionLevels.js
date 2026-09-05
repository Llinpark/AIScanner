/**
 * Session high/low helpers (Asian / London / NY) + PDH/PDL.
 * Times are evaluated in UTC to stay broker-agnostic.
 *
 * @typedef {import('../types').Candle} Candle
 * @typedef {import('../types').LiquidityPool} LiquidityPool
 */

/**
 * @param {number|Date} time
 * @returns {{ hour: number, minute: number, dayKey: string }}
 */
function utcParts(time) {
  const d = time instanceof Date ? time : new Date(time);
  return {
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dayKey: d.toISOString().slice(0, 10)
  };
}

/**
 * @param {number} hour
 * @param {{ startHour: number, endHour: number }} session
 */
function inSession(hour, session) {
  const { startHour, endHour } = session;
  if (startHour <= endHour) return hour >= startHour && hour < endHour;
  // wraps midnight
  return hour >= startHour || hour < endHour;
}

/**
 * Compute session H/L for the most recent completed session window on HTF candles.
 * Cached callers should pass existing maps and only fold new candles.
 *
 * @param {Candle[]} candles
 * @param {Object} sessions - config.sessions
 * @returns {{ asian: {high:number,low:number}|null, london: {high:number,low:number}|null, ny: {high:number,low:number}|null, pdh: number|null, pdl: number|null }}
 */
function computeSessionLevels(candles, sessions) {
  if (!candles.length) {
    return { asian: null, london: null, ny: null, pdh: null, pdl: null };
  }

  /** @type {Record<string, { high: number, low: number }>} */
  const byDay = {};
  /** @type {Record<string, Record<string, { high: number, low: number }>>} */
  const sessionByDay = { asian: {}, london: {}, ny: {} };

  for (const c of candles) {
    const { hour, dayKey } = utcParts(c.time);
    if (!byDay[dayKey]) {
      byDay[dayKey] = { high: c.high, low: c.low };
    } else {
      byDay[dayKey].high = Math.max(byDay[dayKey].high, c.high);
      byDay[dayKey].low = Math.min(byDay[dayKey].low, c.low);
    }

    for (const name of ['asian', 'london', 'ny']) {
      if (!inSession(hour, sessions[name])) continue;
      const bucket = sessionByDay[name];
      if (!bucket[dayKey]) {
        bucket[dayKey] = { high: c.high, low: c.low };
      } else {
        bucket[dayKey].high = Math.max(bucket[dayKey].high, c.high);
        bucket[dayKey].low = Math.min(bucket[dayKey].low, c.low);
      }
    }
  }

  const days = Object.keys(byDay).sort();
  const today = days[days.length - 1];
  const prevDay = days.length >= 2 ? days[days.length - 2] : null;

  const latestSession = name => {
    const keys = Object.keys(sessionByDay[name]).sort();
    if (!keys.length) return null;
    // Prefer yesterday's completed session when today is partial
    const key = keys.length >= 2 ? keys[keys.length - 2] : keys[keys.length - 1];
    return sessionByDay[name][key] || null;
  };

  return {
    asian: latestSession('asian'),
    london: latestSession('london'),
    ny: latestSession('ny'),
    pdh: prevDay ? byDay[prevDay].high : null,
    pdl: prevDay ? byDay[prevDay].low : null,
    pwh: null,
    pwl: null,
    _today: today,
    _byDay: byDay
  };
}

/**
 * Previous week high/low from daily aggregates (ISO week, UTC).
 * @param {Record<string, { high: number, low: number }>} byDay
 * @returns {{ pwh: number|null, pwl: number|null }}
 */
function computeWeeklyLevels(byDay = {}) {
  const days = Object.keys(byDay).sort();
  if (days.length < 2) return { pwh: null, pwl: null };

  /** @type {Record<string, { high: number, low: number }>} */
  const weeks = {};
  for (const day of days) {
    const d = new Date(`${day}T00:00:00.000Z`);
    const weekKey = isoWeekKey(d);
    if (!weeks[weekKey]) {
      weeks[weekKey] = { high: byDay[day].high, low: byDay[day].low };
    } else {
      weeks[weekKey].high = Math.max(weeks[weekKey].high, byDay[day].high);
      weeks[weekKey].low = Math.min(weeks[weekKey].low, byDay[day].low);
    }
  }

  const weekKeys = Object.keys(weeks).sort();
  const prev = weekKeys.length >= 2 ? weekKeys[weekKeys.length - 2] : null;
  if (!prev) return { pwh: null, pwl: null };
  return { pwh: weeks[prev].high, pwl: weeks[prev].low };
}

/**
 * Previous month high/low from daily aggregates (UTC calendar month).
 * @param {Record<string, { high: number, low: number }>} byDay
 * @returns {{ pmh: number|null, pml: number|null }}
 */
function computeMonthlyLevels(byDay = {}) {
  const days = Object.keys(byDay).sort();
  if (days.length < 2) return { pmh: null, pml: null };

  /** @type {Record<string, { high: number, low: number }>} */
  const months = {};
  for (const day of days) {
    const monthKey = day.slice(0, 7); // YYYY-MM
    if (!months[monthKey]) {
      months[monthKey] = { high: byDay[day].high, low: byDay[day].low };
    } else {
      months[monthKey].high = Math.max(months[monthKey].high, byDay[day].high);
      months[monthKey].low = Math.min(months[monthKey].low, byDay[day].low);
    }
  }

  const monthKeys = Object.keys(months).sort();
  const prev = monthKeys.length >= 2 ? monthKeys[monthKeys.length - 2] : null;
  if (!prev) return { pmh: null, pml: null };
  return { pmh: months[prev].high, pml: months[prev].low };
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * @param {ReturnType<typeof computeSessionLevels>} levels
 * @returns {LiquidityPool[]}
 */
function sessionPoolsFromLevels(levels) {
  /** @type {LiquidityPool[]} */
  const pools = [];
  const push = (type, price, side) => {
    if (price == null || !Number.isFinite(price)) return;
    pools.push({ type, price, side, sweepCount: 0 });
  };

  if (levels.pdh != null) push('pdh', levels.pdh, 'buy_side');
  if (levels.pdl != null) push('pdl', levels.pdl, 'sell_side');
  if (levels.pwh != null) push('pwh', levels.pwh, 'buy_side');
  if (levels.pwl != null) push('pwl', levels.pwl, 'sell_side');
  if (levels.pmh != null) push('pmh', levels.pmh, 'buy_side');
  if (levels.pml != null) push('pml', levels.pml, 'sell_side');
  if (levels.asian) {
    push('asian_high', levels.asian.high, 'buy_side');
    push('asian_low', levels.asian.low, 'sell_side');
  }
  if (levels.london) {
    push('london_high', levels.london.high, 'buy_side');
    push('london_low', levels.london.low, 'sell_side');
  }
  if (levels.ny) {
    push('ny_high', levels.ny.high, 'buy_side');
    push('ny_low', levels.ny.low, 'sell_side');
  }

  return pools;
}

/**
 * Psychological round levels near price (e.g. 1.1000, 2650).
 * @param {number} price
 * @param {string} [symbol]
 * @param {number} [stepMult=1]
 * @returns {LiquidityPool[]}
 */
function roundPsychologicalPools(price, symbol = '', stepMult = 1) {
  if (!Number.isFinite(price) || price <= 0) return [];
  const s = String(symbol).toUpperCase();
  let step = 0.01;
  if (s.includes('JPY')) step = 1;
  else if (s.includes('XAU') || s.includes('GOLD') || price >= 100) step = 10;
  else if (price >= 10) step = 1;
  else step = 0.01;
  step *= stepMult || 1;

  const nearest = Math.round(price / step) * step;
  const levels = [nearest - step, nearest, nearest + step];
  /** @type {LiquidityPool[]} */
  const pools = [];
  for (const lvl of levels) {
    if (!(lvl > 0)) continue;
    pools.push({
      type: 'round_psychological',
      price: lvl,
      side: lvl >= price ? 'buy_side' : 'sell_side',
      sweepCount: 0
    });
  }
  return pools;
}

module.exports = {
  utcParts,
  inSession,
  computeSessionLevels,
  computeWeeklyLevels,
  computeMonthlyLevels,
  sessionPoolsFromLevels,
  roundPsychologicalPools,
  isoWeekKey
};
