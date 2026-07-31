/**
 * MarketRegimeService — strategy-agnostic pre-scan gate.
 *
 * Evaluates whether market conditions are suitable before Liquidity Sweep + FVG
 * (or any future strategy). Independent of trading strategy internals.
 *
 * Cache: Redis when available (same client as MarketDataHub); in-memory TTL fallback.
 */

const { atr, toPips, isSidewaysMarket, getPipSize } = require('../strategies/utils/candleMath');
const { inSession } = require('../strategies/utils/sessionLevels');
const { evaluateNewsImpact } = require('../utils/newsFilter');
const { getRedisClient } = require('../utils/redisClient');
const {
  getMarketRegimeConfig,
  DEFAULT_SESSIONS,
  resolveRegimeMaxSpreadPips
} = require('../utils/marketRegimeConfig');
const { normalizeSymbol } = require('../config/symbols');

const memoryCache = new Map();
const CACHE_PREFIX = 'market_regime:';

const REGIMES = Object.freeze([
  'TRENDING',
  'RANGING',
  'LOW_LIQUIDITY',
  'HIGH_VOLATILITY',
  'NEWS',
  'MARKET_CLOSED'
]);

function isCryptoSymbol(symbol = '') {
  const s = String(symbol).toUpperCase();
  return (
    s.includes('BTC') ||
    s.includes('ETH') ||
    s.includes('CRYPTO') ||
    s.endsWith('USDT') ||
    s.endsWith('USD-PERP')
  );
}

/**
 * FX / metals roughly closed on weekends (UTC). Crypto always open.
 * @param {Date} at
 * @param {string} symbol
 */
function isMarketClosed(at, symbol) {
  if (isCryptoSymbol(symbol)) return false;
  const day = at.getUTCDay(); // 0 Sun … 6 Sat
  const hour = at.getUTCHours();
  if (day === 6) return true; // Saturday
  if (day === 0 && hour < 21) return true; // Sunday before ~Asia open
  return false;
}

/**
 * @param {Date} at
 * @param {Object} sessions
 */
function resolveSessionInfo(at, sessions = DEFAULT_SESSIONS) {
  const hour = at.getUTCHours();
  const asian = inSession(hour, sessions.asian || DEFAULT_SESSIONS.asian);
  const london = inSession(hour, sessions.london || DEFAULT_SESSIONS.london);
  const ny = inSession(hour, sessions.ny || DEFAULT_SESSIONS.ny);
  const overlap = (london && ny) || (asian && london);
  let name = 'off_hours';
  if (overlap && london && ny) name = 'london_ny_overlap';
  else if (overlap && asian && london) name = 'asian_london_overlap';
  else if (ny) name = 'ny';
  else if (london) name = 'london';
  else if (asian) name = 'asian';
  return { asian, london, ny, overlap, name };
}

function averageVolume(candles, lookback = 20) {
  const slice = candles.slice(-lookback);
  if (!slice.length) return 0;
  return slice.reduce((sum, c) => sum + (Number(c.volume) || 0), 0) / slice.length;
}

/**
 * Volatility score 0–100 from ATR vs longer average.
 * ~50 = normal; higher = more active; lower = quiet.
 */
function volatilityScoreFromAtr(currentAtr, avgAtr) {
  if (!(currentAtr > 0) || !(avgAtr > 0)) return null;
  const ratio = currentAtr / avgAtr;
  // Map ratio 0.3→10, 1.0→55, 2.0→90, clamp
  const score = Math.round(55 + (ratio - 1) * 40);
  return Math.max(0, Math.min(100, score));
}

function classifyRegime({
  marketClosed,
  newsBlocked,
  lowLiquidity,
  highVol,
  ranging,
  atrPips,
  minAtrPips
}) {
  if (marketClosed) return 'MARKET_CLOSED';
  if (newsBlocked) return 'NEWS';
  if (lowLiquidity || (atrPips != null && atrPips < minAtrPips)) return 'LOW_LIQUIDITY';
  if (highVol) return 'HIGH_VOLATILITY';
  if (ranging) return 'RANGING';
  return 'TRENDING';
}

/**
 * Pure decision core (unit-testable). Does not fetch or cache.
 *
 * @param {Object} input
 * @returns {{ shouldScan: boolean, score: number, regime: string, reasons: string[], metrics: Object }}
 */
function evaluateFromInputs(input = {}) {
  const cfg = { ...getMarketRegimeConfig(), ...(input.config || {}) };
  const symbol = normalizeSymbol(input.symbol || '');
  const timeframe = String(input.timeframe || '15m');
  const maxSpreadPips = resolveRegimeMaxSpreadPips(symbol, cfg);
  cfg.maxSpreadPips = maxSpreadPips;
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const reasons = [];
  const unavailable = [];

  const marketClosed = isMarketClosed(now, symbol);
  const session = resolveSessionInfo(now, cfg.sessions);
  const news = evaluateNewsImpact(now);
  const newsBlocked = Boolean(cfg.avoidHighImpactNews && news.avoidNewEntries);

  let atrValue = input.atr;
  let avgAtr = input.avgAtr;
  const candles = Array.isArray(input.candles) ? input.candles : [];

  if ((atrValue == null || avgAtr == null) && candles.length >= 5) {
    atrValue = atrValue != null ? atrValue : atr(candles, 14);
    avgAtr = avgAtr != null ? avgAtr : atr(candles.slice(0, -14), 14) || atr(candles, 28);
  }

  let atrPips = null;
  if (atrValue != null && Number.isFinite(atrValue) && atrValue > 0) {
    atrPips = toPips(atrValue, symbol);
  } else {
    unavailable.push('ATR');
  }

  let spreadPips = input.spreadPips;
  if (spreadPips == null && input.spread != null && Number.isFinite(Number(input.spread))) {
    const pip = getPipSize(symbol);
    spreadPips = pip > 0 ? Number(input.spread) / pip : Number(input.spread);
  }
  if (spreadPips == null || !Number.isFinite(spreadPips)) {
    unavailable.push('spread');
    spreadPips = null;
  }

  let volScore =
    input.volatilityScore != null
      ? Number(input.volatilityScore)
      : volatilityScoreFromAtr(atrValue, avgAtr);
  if (volScore == null || !Number.isFinite(volScore)) {
    unavailable.push('volatility');
    volScore = 50; // neutral when unknown
  }

  let liquidityOk = true;
  if (candles.length >= 10) {
    const avgVol = averageVolume(candles, 20);
    const recentVol = averageVolume(candles.slice(-5), 5);
    if (avgVol > 0) {
      if (recentVol < avgVol * 0.35) {
        liquidityOk = false;
        reasons.push('Recent volume well below average (thin liquidity)');
      }
    } else {
      unavailable.push('volume/liquidity');
    }
  } else if (!candles.length) {
    unavailable.push('candles');
  }

  const ranging = candles.length >= 30 ? isSidewaysMarket(candles) : Boolean(input.ranging);
  const highVol = atrValue > 0 && avgAtr > 0 && atrValue / avgAtr >= 2.2;

  // --- Soft score (0–100) ---
  let score = 70;
  if (marketClosed) score -= 80;
  if (newsBlocked) score -= 50;
  else if (news.impact === 'medium') score -= 10;

  if (atrPips != null) {
    if (atrPips < cfg.minAtrPips) score -= 35;
    else if (atrPips < cfg.minAtrPips * 1.5) score -= 10;
    else score += 5;
  }

  if (spreadPips != null) {
    if (spreadPips > cfg.maxSpreadPips) score -= 30;
    else if (spreadPips > cfg.maxSpreadPips * 0.7) score -= 10;
    else score += 5;
  }

  if (volScore < cfg.minVolatilityScore) score -= 25;
  else if (volScore >= 45 && volScore <= 85) score += 8;
  else if (volScore > 90) score -= 8; // extreme chop risk

  if (!liquidityOk) score -= 20;
  if (ranging) score -= 8;
  if (highVol) score -= 5;

  // Session allow-lists
  if (session.overlap) {
    if (!cfg.allowSessionOverlap) {
      score -= 40;
      reasons.push('Session overlap not allowed by settings');
    } else {
      score += 5;
    }
  } else if (session.asian && !session.london && !session.ny) {
    if (!cfg.allowAsianSession) {
      score -= 40;
      reasons.push('Asian session not allowed by settings');
    }
    if (cfg.avoidLowLiquiditySessions) {
      score -= 25;
      reasons.push('Low-liquidity session avoidance (Asian)');
    }
  } else if (session.london && !session.ny) {
    if (!cfg.allowLondonSession) {
      score -= 40;
      reasons.push('London session not allowed by settings');
    } else {
      score += 5;
    }
  } else if (session.ny) {
    if (!cfg.allowNewYorkSession) {
      score -= 40;
      reasons.push('New York session not allowed by settings');
    } else {
      score += 5;
    }
  } else if (session.name === 'off_hours') {
    score -= 15;
    reasons.push('Outside primary FX sessions');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const lowLiquidity =
    !liquidityOk ||
    (cfg.avoidLowLiquiditySessions && session.asian && !session.london && !session.ny) ||
    (atrPips != null && atrPips < cfg.minAtrPips);

  const regime = classifyRegime({
    marketClosed,
    newsBlocked,
    lowLiquidity,
    highVol,
    ranging,
    atrPips,
    minAtrPips: cfg.minAtrPips
  });

  // Hard skips
  const hardFails = [];
  if (marketClosed) hardFails.push('Market closed (weekend FX hours)');
  if (newsBlocked) hardFails.push(`High-impact news: ${news.label}`);
  if (atrPips != null && atrPips < cfg.minAtrPips) {
    hardFails.push(`ATR ${atrPips.toFixed(1)} pips below minimum ${cfg.minAtrPips}`);
  }
  if (spreadPips != null && spreadPips > cfg.maxSpreadPips) {
    hardFails.push(`Spread ${spreadPips.toFixed(1)} pips above maximum ${cfg.maxSpreadPips}`);
  }
  if (volScore < cfg.minVolatilityScore) {
    hardFails.push(`Volatility score ${volScore} below minimum ${cfg.minVolatilityScore}`);
  }
  if (session.overlap && !cfg.allowSessionOverlap) hardFails.push('Overlap session blocked');
  if (session.asian && !session.london && !session.ny && !cfg.allowAsianSession) {
    hardFails.push('Asian session blocked');
  }
  if (session.london && !session.ny && !session.overlap && !cfg.allowLondonSession) {
    hardFails.push('London session blocked');
  }
  if (session.ny && !session.overlap && !cfg.allowNewYorkSession) {
    hardFails.push('New York session blocked');
  }
  if (cfg.avoidLowLiquiditySessions && session.asian && !session.london && !session.ny) {
    hardFails.push('Low-liquidity Asian session avoided');
  }
  if (score < cfg.minRegimeScore) {
    hardFails.push(`Regime score ${score} below minimum ${cfg.minRegimeScore}`);
  }

  for (const r of hardFails) {
    if (!reasons.includes(r)) reasons.push(r);
  }
  if (unavailable.length) {
    reasons.push(`Degraded inputs (unavailable: ${unavailable.join(', ')})`);
  }
  if (!reasons.length && cfg.enabled) {
    reasons.push(`Suitable regime (${regime}), session=${session.name}`);
  }

  const shouldScan = !cfg.enabled ? true : hardFails.length === 0;

  return {
    shouldScan,
    score,
    regime,
    reasons,
    metrics: {
      symbol,
      timeframe,
      atrPips,
      spreadPips,
      maxSpreadPips,
      volatilityScore: volScore,
      session: session.name,
      newsImpact: news.impact,
      marketClosed,
      filterEnabled: cfg.enabled,
      unavailable
    }
  };
}

function cacheKey(symbol, timeframe) {
  return `${CACHE_PREFIX}${normalizeSymbol(symbol)}:${String(timeframe || '15m')}`;
}

async function readCache(key) {
  const redis = await getRedisClient();
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw);
    } catch (_) {
      /* fall through to memory */
    }
  }
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value;
}

async function writeCache(key, value, ttlSeconds) {
  const ttl = Math.max(5, Number(ttlSeconds) || 60);
  memoryCache.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  const redis = await getRedisClient();
  if (redis) {
    try {
      await redis.setEx(key, ttl, JSON.stringify(value));
    } catch (_) {
      /* memory already written */
    }
  }
}

/**
 * Evaluate market regime for a symbol/timeframe.
 * Prefer passing `candles` (post-fetch). Optional `spread` / `spreadPips` / `now`.
 *
 * @param {string} symbol
 * @param {string} [timeframe='15m']
 * @param {Object} [options]
 * @returns {Promise<{ shouldScan: boolean, score: number, regime: string, reasons: string[] }>}
 */
async function evaluate(symbol, timeframe = '15m', options = {}) {
  const cfg = getMarketRegimeConfig();
  const key = cacheKey(symbol, timeframe);
  const skipCache = options.skipCache === true;

  if (!skipCache) {
    const cached = await readCache(key);
    if (cached) return cached;
  }

  let candles = options.candles;
  if (!candles?.length && options.fetchCandles !== false) {
    try {
      const { getMarketDataHub } = require('./MarketDataHubService');
      const hub = getMarketDataHub();
      const payload = await hub.getCandles(normalizeSymbol(symbol), timeframe, 80, {
        allowProviderFetch: options.allowProviderFetch === true,
        cacheOnly: options.allowProviderFetch !== true
      });
      candles = (payload?.candles || []).map(c => ({
        time: typeof c.timestamp === 'string' ? Date.parse(c.timestamp) : c.time || Date.now(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0)
      }));
    } catch (err) {
      // Degrade: evaluate without candles
      candles = [];
    }
  }

  const result = evaluateFromInputs({
    symbol,
    timeframe,
    candles: candles || [],
    spread: options.spread,
    spreadPips: options.spreadPips,
    atr: options.atr,
    avgAtr: options.avgAtr,
    volatilityScore: options.volatilityScore,
    ranging: options.ranging,
    now: options.now,
    config: options.config
  });

  const publicResult = {
    shouldScan: result.shouldScan,
    score: result.score,
    regime: result.regime,
    reasons: result.reasons
  };

  await writeCache(key, publicResult, cfg.cacheTtlSeconds);
  return publicResult;
}

function logSkip(symbol, timeframe, result) {
  console.log(
    `[MarketRegime] Skip ${normalizeSymbol(symbol)} ${timeframe} ` +
      `regime=${result.regime} score=${result.score} ` +
      `reasons=${(result.reasons || []).join(' | ')}`
  );
}

function clearMemoryCache() {
  memoryCache.clear();
}

module.exports = {
  evaluate,
  evaluateFromInputs,
  logSkip,
  clearMemoryCache,
  isMarketClosed,
  resolveSessionInfo,
  volatilityScoreFromAtr,
  REGIMES,
  CACHE_PREFIX
};
