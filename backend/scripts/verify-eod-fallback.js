/**
 * Smoke-test EODHD daily remap when Twelve Data is unavailable.
 * Run: node backend/scripts/verify-eod-fallback.js
 */
const Module = require('module');
const originalLoad = Module._load;

const mockCandles = [
  { time: Date.UTC(2026, 0, 1), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  { time: Date.UTC(2026, 0, 2), open: 1.5, high: 2.5, low: 1, close: 2, volume: 12 }
];

let twelveCalls = 0;
let eodSeriesCalls = 0;
let eodhdHistoricalCalls = 0;
let lastEodInterval = null;

Module._load = function mockLoad(request, parent, isMain) {
  if (request === './twelveData' && parent?.filename?.includes('marketData.js')) {
    return {
      fetchTimeSeries: async () => {
        twelveCalls += 1;
        throw new Error('You have run out of API credits for the current minute. Please wait.');
      }
    };
  }
  if (request === './eodhd' && parent?.filename?.includes('marketData.js')) {
    const real = originalLoad(request, parent, isMain);
    return {
      ...real,
      fetchEodSeries: async ({ interval }) => {
        eodSeriesCalls += 1;
        lastEodInterval = interval;
        return mockCandles.slice();
      },
      fetchHistoricalSeries: async () => {
        eodhdHistoricalCalls += 1;
        throw new Error('Only EOD data allowed for free users');
      }
    };
  }
  return originalLoad(request, parent, isMain);
};

const {
  fetchHistoricalData,
  markTwelveDataUnavailable,
  shouldSkipTwelveData,
  planEodhdFetch
} = require('../utils/marketData');
const { getFresh } = require('../utils/marketDataCache');

async function main() {
  process.env.MARKET_DATA_PRIMARY = 'twelve_data';
  process.env.MARKET_DATA_FALLBACK = 'eodhd';

  const config = {
    providers: {
      twelve_data: { apiKey: 'td', baseUrl: 'https://example.test' },
      eodhd: { apiKey: 'eod', baseUrl: 'https://example.test' }
    }
  };

  const forcePlan = planEodhdFetch('1h', { forceEodFallback: true });
  if (forcePlan.interval !== '1d' || !forcePlan.remapped) {
    throw new Error('planEodhdFetch should remap intraday to 1d when forced');
  }

  // Path A: Twelve Data rate-limit → proactive EODHD 1d
  twelveCalls = 0;
  eodSeriesCalls = 0;
  eodhdHistoricalCalls = 0;
  const candles = await fetchHistoricalData(config, 'EUR/USD', '1h', 50, { forceRefresh: true });
  if (!candles?.length) throw new Error('expected candles from EOD remap');
  if (candles.meta?.provider !== 'eodhd') throw new Error('expected provider eodhd');
  if (!candles.meta?.fallback_used) throw new Error('expected fallback_used');
  if (candles.meta?.fallback_interval !== '1d') throw new Error('expected fallback_interval 1d');
  if (lastEodInterval !== '1d') throw new Error('expected fetchEodSeries(1d)');
  if (eodhdHistoricalCalls !== 0) {
    throw new Error('should not call intraday when twelve limited after failure');
  }
  if (!shouldSkipTwelveData()) throw new Error('expected twelve skip cooldown after credit error');

  const cached = getFresh('market:EUR/USD:1h:50');
  if (!cached?.meta?.fallback_interval) throw new Error('expected cache under requested interval key');

  const cachedDaily = getFresh('market:EUR/USD:1d:50');
  if (!cachedDaily?.length) throw new Error('expected cache under remapped 1d key');

  // Path B: skip cooldown + intraday → proactive EOD (no twelve call)
  twelveCalls = 0;
  eodSeriesCalls = 0;
  eodhdHistoricalCalls = 0;
  markTwelveDataUnavailable('You have run out of API credits for the current minute. Please wait.');
  const again = await fetchHistoricalData(config, 'GBP/USD', '5m', 40, { forceRefresh: true });
  if (twelveCalls !== 0) throw new Error('twelve should be skipped during cooldown');
  if (eodSeriesCalls !== 1 || eodhdHistoricalCalls !== 0) {
    throw new Error('cooldown path should call EOD series only');
  }
  if (again.meta?.fallback_interval !== '1d') throw new Error('cooldown path should remap to 1d');
  if (again.meta?.provider !== 'eodhd') throw new Error('cooldown path should report eodhd');

  console.log('verify-eod-fallback: ALL PASSED');
}

main().catch(error => {
  console.error('verify-eod-fallback: FAILED', error.message);
  process.exit(1);
});
