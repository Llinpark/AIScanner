const { getMarketDataHub } = require('./MarketDataHubService');
const ChartDataService = require('./ChartDataService');

const DEFAULT_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.PYTHON_SERVICE_TIMEOUT_MS || 15000)
);

function getPythonServiceUrl() {
  const url = String(process.env.PYTHON_SERVICE_URL || '').trim().replace(/\/$/, '');
  return url || null;
}

function isConfigured() {
  return Boolean(getPythonServiceUrl());
}

function toPythonCandles(candles = []) {
  return (candles || [])
    .map(c => {
      const rawTime = c.timestamp ?? c.time;
      let timestamp = null;
      if (typeof rawTime === 'number' && Number.isFinite(rawTime)) {
        const ms = rawTime > 1e12 ? rawTime : rawTime * 1000;
        timestamp = new Date(ms).toISOString();
      } else if (rawTime) {
        timestamp = new Date(rawTime).toISOString();
      }
      if (!timestamp || Number.isNaN(Date.parse(timestamp))) return null;
      return {
        timestamp,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0)
      };
    })
    .filter(Boolean);
}

/**
 * Resolve OHLC bars from the Node hub (preferred) or ChartDataService.
 * Never asks Python to fetch market data.
 */
async function resolveCandlesForAi(symbol, interval = '1h', lookback = 200, options = {}) {
  if (options.candles?.length) {
    return toPythonCandles(options.candles);
  }

  const parsedLimit = Math.max(20, Math.min(5000, Number(lookback) || 200));

  try {
    const hub = getMarketDataHub();
    const payload = await hub.getCandles(symbol, interval, parsedLimit, {
      allowProviderFetch: options.allowProviderFetch !== false,
      cacheOnly: Boolean(options.cacheOnly)
    });
    const rows = toPythonCandles(payload?.candles || []);
    if (rows.length) return rows;
  } catch (error) {
    console.warn('[PythonAi] Hub candles unavailable:', error.message);
  }

  try {
    const historical = await ChartDataService.getHistoricalData(symbol, interval, parsedLimit);
    return toPythonCandles(historical);
  } catch (error) {
    console.warn('[PythonAi] ChartDataService candles unavailable:', error.message);
    return [];
  }
}

/**
 * Call FastAPI POST /signal with Node-supplied candles.
 * Returns null when PYTHON_SERVICE_URL is unset or the call fails (non-fatal).
 */
async function createSignal({ symbol, interval = '1h', lookback = 200, candles } = {}, options = {}) {
  const baseUrl = getPythonServiceUrl();
  if (!baseUrl) {
    return null;
  }

  const bars = await resolveCandlesForAi(symbol, interval, lookback, {
    candles,
    allowProviderFetch: options.allowProviderFetch,
    cacheOnly: options.cacheOnly
  });

  if (!bars.length) {
    const err = new Error('No candles available to send to Python AI service');
    if (options.throwOnError) throw err;
    console.warn('[PythonAi]', err.message);
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        symbol,
        interval,
        lookback: Math.max(bars.length, Number(lookback) || 200),
        candles: bars
      }),
      signal: controller.signal
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { detail: text };
    }

    if (!response.ok) {
      const detail = payload?.detail || payload?.message || response.statusText;
      const err = new Error(`Python AI signal failed (${response.status}): ${detail}`);
      if (options.throwOnError) throw err;
      console.warn('[PythonAi]', err.message);
      return null;
    }

    return payload;
  } catch (error) {
    if (options.throwOnError) throw error;
    console.warn('[PythonAi] Request failed:', error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function healthCheck() {
  const baseUrl = getPythonServiceUrl();
  if (!baseUrl) {
    return { configured: false, ok: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(DEFAULT_TIMEOUT_MS, 5000));
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    return { configured: true, ok: response.ok, status: response.status, body };
  } catch (error) {
    return { configured: true, ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isConfigured,
  getPythonServiceUrl,
  resolveCandlesForAi,
  createSignal,
  healthCheck,
  toPythonCandles
};
