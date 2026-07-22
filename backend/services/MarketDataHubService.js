const { normalizeSymbol } = require('../config/symbols');
const { TRADINGVIEW_CONFIG } = require('../config/tradingview');
const { fetchHistoricalData, twelveDataSkipStatus } = require('../utils/marketData');
const { isRateLimitError } = require('../utils/marketDataCache');
const { getRedisClient } = require('../utils/redisClient');
const {
  cacheTtlSecondsForInterval,
  normalizeInterval,
  refreshMsForInterval
} = require('../utils/marketIntervals');

const DEFAULT_LIMIT = 200;
const STALE_TTL_SECONDS = Math.max(
  300,
  Math.floor(Number(process.env.MARKET_DATA_STALE_TTL_MS || 900_000) / 1000)
);
const MIN_PROVIDER_FETCH_GAP_MS = Math.max(
  1000,
  Number(process.env.MARKET_DATA_MIN_FETCH_GAP_MS || 9000)
);
const RATE_LIMIT_COOLDOWN_MS = Math.max(
  30_000,
  Number(process.env.MARKET_DATA_RATE_LIMIT_COOLDOWN_MS || 65_000)
);

function isEodhdConfigured() {
  return Boolean(TRADINGVIEW_CONFIG.providers?.eodhd?.apiKey || process.env.EODHD_API_KEY);
}

class MarketDataHub {
  constructor(io) {
    this.io = io;
    this.memoryCache = new Map();
    this.streams = new Map();
    this.inFlight = new Map();
    this.lastProviderFetchAt = 0;
    this.providerBlockedUntil = 0;
    this.lastRateLimitMessage = null;
  }

  canFetchFromProvider(options = {}) {
    const bypassGap = Boolean(options.bypassGap);
    // Hub-wide pause when neither provider can serve (no EODHD key).
    if (!isEodhdConfigured() && Date.now() < this.providerBlockedUntil) return false;
    // Always space provider calls — free Twelve Data is ~8 credits/min and EODHD
    // free tier often cannot cover intraday fallback.
    if (!bypassGap && Date.now() - this.lastProviderFetchAt < MIN_PROVIDER_FETCH_GAP_MS) return false;
    return true;
  }

  markProviderRateLimited(message) {
    this.lastRateLimitMessage = message || 'Provider rate limited';
    if (isEodhdConfigured()) {
      // Do not freeze the hub — marketData.js skips Twelve Data and uses EODHD immediately.
      console.warn(
        '[MarketDataHub] Primary provider limited/out of credits — continuing via EODHD fallback'
      );
      return;
    }
    this.providerBlockedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    console.warn(
      `[MarketDataHub] Provider rate limited — pausing fetches for ${RATE_LIMIT_COOLDOWN_MS}ms (no EODHD key)`
    );
  }

  providerThrottleStatus() {
    const now = Date.now();
    const twelveSkip = twelveDataSkipStatus();
    return {
      canFetch: this.canFetchFromProvider(),
      blockedUntil:
        !isEodhdConfigured() && this.providerBlockedUntil > now
          ? new Date(this.providerBlockedUntil).toISOString()
          : null,
      lastFetchAt: this.lastProviderFetchAt ? new Date(this.lastProviderFetchAt).toISOString() : null,
      minFetchGapMs: MIN_PROVIDER_FETCH_GAP_MS,
      lastRateLimitMessage: this.lastRateLimitMessage,
      eodhdConfigured: isEodhdConfigured(),
      twelveDataSkip: twelveSkip
    };
  }

  start() {
    console.log('[MarketDataHub] Demand-driven refresh enabled (symbol+timeframe viewers only)');
  }

  stop() {
    for (const stream of this.streams.values()) {
      this.stopStreamTimer(stream);
    }
    this.streams.clear();
  }

  streamKey(symbol, interval) {
    return `${normalizeSymbol(symbol)}:${normalizeInterval(interval)}`;
  }

  roomKey(symbol, interval) {
    return `market:${this.streamKey(symbol, interval)}`;
  }

  cacheRedisKey(symbol, interval, limit) {
    return `kaching:candles:${this.streamKey(symbol, interval)}:${limit}`;
  }

  normalizePayload(symbol, interval, limit, candles, meta = {}) {
    const normalized = normalizeSymbol(symbol);
    const canonicalInterval = normalizeInterval(interval);
    const rows = (candles || []).map(candle => {
      const rawTime = candle.time ?? candle.timestamp;
      let timestamp = null;
      if (typeof rawTime === 'number' && Number.isFinite(rawTime)) {
        const ms = rawTime > 1e12 ? rawTime : rawTime * 1000;
        timestamp = new Date(ms).toISOString();
      } else if (rawTime) {
        timestamp = new Date(rawTime).toISOString();
      }
      return {
        timestamp,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume || 0)
      };
    }).filter(row => row.timestamp && Number.isFinite(row.close));

    return {
      provider: meta.provider || TRADINGVIEW_CONFIG.primaryProvider || 'twelve_data',
      symbol: normalized,
      provider_symbol: meta.provider_symbol || normalized,
      interval: canonicalInterval,
      requested_limit: limit,
      count: rows.length,
      fallback_used: Boolean(meta.fallback_used),
      source: meta.source || 'hub',
      cached: true,
      cachedAt: new Date().toISOString(),
      refreshMs: refreshMsForInterval(canonicalInterval),
      viewers: meta.viewers || 0,
      candles: rows
    };
  }

  async readCache(symbol, interval, limit = DEFAULT_LIMIT) {
    const key = this.cacheRedisKey(symbol, interval, limit);
    const redis = await getRedisClient();
    if (redis) {
      try {
        const raw = await redis.get(key);
        if (raw) {
          return JSON.parse(raw);
        }
      } catch (error) {
        console.warn('[MarketDataHub] Redis read failed:', error.message);
      }
    }

    const memoryEntry = this.memoryCache.get(key);
    if (!memoryEntry) return null;
    if (Date.now() - memoryEntry.storedAt > STALE_TTL_SECONDS * 1000) {
      this.memoryCache.delete(key);
      return null;
    }
    return memoryEntry.payload;
  }

  async writeCache(symbol, interval, limit, payload) {
    const key = this.cacheRedisKey(symbol, interval, limit);
    const enriched = { ...payload, cached: true, cachedAt: new Date().toISOString() };
    this.memoryCache.set(key, { payload: enriched, storedAt: Date.now() });

    const redis = await getRedisClient();
    if (redis) {
      try {
        const ttl = cacheTtlSecondsForInterval(interval);
        await redis.setEx(key, ttl, JSON.stringify(enriched));
      } catch (error) {
        console.warn('[MarketDataHub] Redis write failed:', error.message);
      }
    }
    return enriched;
  }

  isFresh(payload, interval) {
    if (!payload?.cachedAt) return false;
    return Date.now() - Date.parse(payload.cachedAt) < refreshMsForInterval(interval);
  }

  async refreshFromProvider(symbol, interval, limit = DEFAULT_LIMIT, options = {}) {
    const normalized = normalizeSymbol(symbol);
    const canonicalInterval = normalizeInterval(interval);
    const parsedLimit = Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT);
    const dedupeKey = `${this.streamKey(normalized, canonicalInterval)}:${parsedLimit}`;
    const forceProviderRefresh = Boolean(options.forceProviderRefresh);

    if (this.inFlight.has(dedupeKey)) {
      return this.inFlight.get(dedupeKey);
    }

    if (!this.canFetchFromProvider({ bypassGap: !forceProviderRefresh })) {
      const cached = await this.readCache(normalized, canonicalInterval, parsedLimit);
      if (cached) {
        return { ...cached, stale: true };
      }
      if (!forceProviderRefresh) {
        const candles = await fetchHistoricalData(
          TRADINGVIEW_CONFIG,
          normalized,
          canonicalInterval,
          parsedLimit,
          { forceRefresh: false }
        ).catch(() => null);
        if (candles?.length) {
          const stream = this.streams.get(this.streamKey(normalized, canonicalInterval));
          const payload = this.normalizePayload(normalized, canonicalInterval, parsedLimit, candles, {
            source: 'provider-cache',
            viewers: stream?.viewers || 0
          });
          return this.writeCache(normalized, canonicalInterval, parsedLimit, { ...payload, stale: true });
        }
        throw new Error(
          this.lastRateLimitMessage ||
            'Market data temporarily throttled. Please wait a moment and try again.'
        );
      }
      // Cold start with force refresh: proceed — Twelve Data serializes credits itself.
    }

    const task = (async () => {
      this.lastProviderFetchAt = Date.now();
      try {
        const candles = await fetchHistoricalData(
          TRADINGVIEW_CONFIG,
          normalized,
          canonicalInterval,
          parsedLimit,
          { forceRefresh: forceProviderRefresh }
        );
        const stream = this.streams.get(this.streamKey(normalized, canonicalInterval));
        const payload = this.normalizePayload(normalized, canonicalInterval, parsedLimit, candles, {
          source: 'provider',
          viewers: stream?.viewers || 0
        });
        return this.writeCache(normalized, canonicalInterval, parsedLimit, payload);
      } catch (error) {
        if (isRateLimitError(error.message)) {
          this.markProviderRateLimited(error.message);
        }
        throw error;
      }
    })().finally(() => {
      this.inFlight.delete(dedupeKey);
    });

    this.inFlight.set(dedupeKey, task);
    return task;
  }

  async refreshStream(stream) {
    try {
      const payload = await this.refreshFromProvider(stream.symbol, stream.interval, stream.limit, {
        forceProviderRefresh: true
      });
      stream.lastRefreshAt = new Date().toISOString();
      const enriched = {
        ...payload,
        viewers: stream.viewers,
        refreshMs: stream.refreshMs,
        stale: Boolean(payload.stale)
      };
      this.io.to(this.roomKey(stream.symbol, stream.interval)).emit('market:candles', enriched);
      return enriched;
    } catch (error) {
      const cached = await this.readCache(stream.symbol, stream.interval, stream.limit);
      if (cached) {
        const enriched = {
          ...cached,
          viewers: stream.viewers,
          refreshMs: stream.refreshMs,
          stale: true,
          refreshError: error.message
        };
        this.io.to(this.roomKey(stream.symbol, stream.interval)).emit('market:candles', enriched);
        return enriched;
      }
      throw error;
    }
  }

  startStreamTimer(stream) {
    this.stopStreamTimer(stream);
    stream.refreshMs = refreshMsForInterval(stream.interval);
    stream.timer = setInterval(() => {
      if (stream.viewers <= 0) return;
      if (!this.canFetchFromProvider({ bypassGap: false })) return;
      this.refreshStream(stream).catch(error => {
        console.warn(
          `[MarketDataHub] Refresh failed for ${stream.symbol} ${stream.interval}:`,
          error.message
        );
      });
    }, stream.refreshMs);
    console.log(
      `[MarketDataHub] Polling ${stream.symbol} ${stream.interval} every ${stream.refreshMs}ms (${stream.viewers} viewer(s))`
    );
  }

  stopStreamTimer(stream) {
    if (stream.timer) {
      clearInterval(stream.timer);
      stream.timer = null;
      console.log(`[MarketDataHub] Stopped polling ${stream.symbol} ${stream.interval}`);
    }
  }

  watch(symbol, interval, limit = DEFAULT_LIMIT) {
    const normalized = normalizeSymbol(symbol);
    const canonicalInterval = normalizeInterval(interval);
    const parsedLimit = Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT);
    const key = this.streamKey(normalized, canonicalInterval);

    let stream = this.streams.get(key);
    if (!stream) {
      stream = {
        symbol: normalized,
        interval: canonicalInterval,
        limit: parsedLimit,
        viewers: 0,
        timer: null,
        refreshMs: refreshMsForInterval(canonicalInterval),
        lastRefreshAt: null
      };
      this.streams.set(key, stream);
    }

    stream.viewers += 1;
    stream.limit = Math.max(stream.limit, parsedLimit);

    if (stream.viewers === 1) {
      this.startStreamTimer(stream);
    }

    return { stream, isFirstViewer: stream.viewers === 1 };
  }

  unwatch(symbol, interval) {
    const normalized = normalizeSymbol(symbol);
    const canonicalInterval = normalizeInterval(interval);
    const key = this.streamKey(normalized, canonicalInterval);
    const stream = this.streams.get(key);
    if (!stream) return;

    stream.viewers = Math.max(0, stream.viewers - 1);
    if (stream.viewers === 0) {
      this.stopStreamTimer(stream);
      this.streams.delete(key);
    }
  }

  isStreamWatched(symbol, interval) {
    const stream = this.streams.get(this.streamKey(symbol, interval));
    return Boolean(stream && stream.viewers > 0);
  }

  async getCandles(symbol, interval = '1h', limit = DEFAULT_LIMIT, options = {}) {
    const normalized = normalizeSymbol(symbol);
    const canonicalInterval = normalizeInterval(interval);
    const parsedLimit = Math.max(1, parseInt(limit, 10) || DEFAULT_LIMIT);
    const cached = await this.readCache(normalized, canonicalInterval, parsedLimit);
    const watched = this.isStreamWatched(normalized, canonicalInterval);

    if (cached && this.isFresh(cached, canonicalInterval) && !options.forceRefresh) {
      return { ...cached, viewers: this.streams.get(this.streamKey(normalized, canonicalInterval))?.viewers || 0 };
    }

    if (options.cacheOnly) {
      if (cached) {
        return { ...cached, stale: !this.isFresh(cached, canonicalInterval) };
      }
      return null;
    }

    if (!watched && !options.allowProviderFetch) {
      if (cached) {
        return { ...cached, stale: true };
      }
      throw new Error(`No cached candles for ${normalized} ${canonicalInterval}. Open the chart to start streaming.`);
    }

    const needsRefresh =
      options.forceRefresh || !cached || !this.isFresh(cached, canonicalInterval);

    if (!needsRefresh) {
      const stream = this.streams.get(this.streamKey(normalized, canonicalInterval));
      return { ...cached, stale: false, viewers: stream?.viewers || 0 };
    }

    if (!this.canFetchFromProvider({ bypassGap: true })) {
      if (cached) {
        return { ...cached, stale: true, refreshError: this.lastRateLimitMessage || 'Provider throttled' };
      }
      const fallbackCandles = await fetchHistoricalData(
        TRADINGVIEW_CONFIG,
        normalized,
        canonicalInterval,
        parsedLimit,
        { forceRefresh: false }
      ).catch(() => null);
      if (fallbackCandles?.length) {
        const stream = this.streams.get(this.streamKey(normalized, canonicalInterval));
        const payload = this.normalizePayload(normalized, canonicalInterval, parsedLimit, fallbackCandles, {
          source: 'provider-cache',
          viewers: stream?.viewers || 0
        });
        const stored = await this.writeCache(normalized, canonicalInterval, parsedLimit, payload);
        return {
          ...stored,
          stale: true,
          refreshError: this.lastRateLimitMessage || 'Provider throttled',
          viewers: stream?.viewers || 0
        };
      }
      throw new Error(
        this.lastRateLimitMessage ||
          'Market data temporarily unavailable. Please wait a moment and try again.'
      );
    }

    try {
      const payload = await this.refreshFromProvider(normalized, canonicalInterval, parsedLimit);
      const stream = this.streams.get(this.streamKey(normalized, canonicalInterval));
      return { ...payload, viewers: stream?.viewers || 0, stale: Boolean(payload.stale) };
    } catch (error) {
      if (cached) {
        return { ...cached, stale: true, refreshError: error.message };
      }
      throw error;
    }
  }

  status() {
    return {
      activeStreams: this.streams.size,
      providerThrottle: this.providerThrottleStatus(),
      streams: [...this.streams.values()].map(stream => ({
        symbol: stream.symbol,
        interval: stream.interval,
        viewers: stream.viewers,
        refreshMs: stream.refreshMs,
        lastRefreshAt: stream.lastRefreshAt
      })),
      inFlightRequests: this.inFlight.size,
      streamingEngine: 'backend-broadcast',
      providerUsage: 'historical-only-demand-driven',
      refreshSchedule: {
        M1: '60s',
        M5: '60s',
        M15: '45s',
        M30: '60s',
        H1: '120s',
        H4: '300s',
        D1: '600s',
        W1: '1800s',
        MN: '3600s'
      }
    };
  }
}

let hubInstance = null;

function initMarketDataHub(io) {
  if (!hubInstance) {
    hubInstance = new MarketDataHub(io);
    hubInstance.start();
  }
  return hubInstance;
}

function getMarketDataHub() {
  if (!hubInstance) {
    throw new Error('MarketDataHub is not initialized');
  }
  return hubInstance;
}

module.exports = {
  MarketDataHub,
  initMarketDataHub,
  getMarketDataHub
};
