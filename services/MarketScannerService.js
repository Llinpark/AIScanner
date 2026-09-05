const TradingViewAlertService = require('./TradingViewAlertService');
const TradingViewService = require('./TradingViewService');
const SignalEnrichmentService = require('./SignalEnrichmentService');
const PatternDetectionService = require('./PatternDetectionService');
const MarketRegimeService = require('./MarketRegimeService');
const { getMarketDataHub } = require('./MarketDataHubService');
const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const { normalizeSymbol } = require('../config/symbols');
const { toUserFacingMarketDataError } = require('../utils/marketDataCache');
const { getDefaultRegistry, SCALPING_ID, DAYTRADING_ID } = require('../strategies');
const {
  getScannerEngine,
  getProfileRegistry,
  bootstrapStrategyProfiles
} = require('../strategies/engine');

const candleBuffers = new Map();
const lastEmittedBar = new Map();
const pendingSetups = new Map();
let autoScanTimer = null;
let ioRef = null;
let scanRotationIndex = 0;

function bufferKey(symbol) {
  return String(symbol).toUpperCase();
}

function getCandles(symbol) {
  return candleBuffers.get(bufferKey(symbol)) || [];
}

function appendCandle(symbol, rawCandle) {
  const key = bufferKey(symbol);
  const candle = PatternDetectionService.normalizeCandle(rawCandle);
  const candles = candleBuffers.get(key) || [];

  const last = candles[candles.length - 1];
  if (last && last.time === candle.time) {
    candles[candles.length - 1] = candle;
  } else {
    candles.push(candle);
  }

  const max = PATTERN_SCANNER_CONFIG.candleBufferSize;
  if (candles.length > max) {
    candles.splice(0, candles.length - max);
  }

  candleBuffers.set(key, candles);
  return candles;
}

function shouldEmit(symbol, barTime) {
  const key = `${bufferKey(symbol)}:${barTime}`;
  const last = lastEmittedBar.get(key);
  const now = Date.now();
  if (last && now - last < PATTERN_SCANNER_CONFIG.duplicateBarCooldownMs) {
    return false;
  }
  lastEmittedBar.set(key, now);
  return true;
}

async function publishEntrySignal(io, symbol, detection) {
  // Architecture lock: trading signals must never be generated from live providers.
  // Production path is TradingView webhook → TradingViewAlertService only.
  console.warn(
    `[Scanner] Refusing live-candle publish for ${symbol} (${detection?.pattern || 'n/a'}) — ` +
      'TradingView webhook is the sole signal source'
  );
  return null;
}

async function fetchHtfCandles(symbol, options = {}) {
  if (!PATTERN_SCANNER_CONFIG.pipeline?.enabled && !options.force) return [];

  const htfTimeframe = options.timeframe || PATTERN_SCANNER_CONFIG.pipeline.htf?.timeframe || '4h';
  try {
    const hub = getMarketDataHub();
    // Manual/internal scanner may live-fetch; timer/background assist stays cache-only.
    const allowLive = options.allowProviderFetch === true;
    const payload = await hub.getCandles(symbol, htfTimeframe, 60, {
      allowProviderFetch: allowLive,
      cacheOnly: !allowLive
    });
    if (!payload?.candles?.length) return [];
    return (payload.candles || [])
      .map(c =>
        PatternDetectionService.normalizeCandle({
          time: Date.parse(c.timestamp),
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume
        })
      )
      .sort((a, b) => a.time - b.time);
  } catch {
    return [];
  }
}

/**
 * Fetch HTF candles for a Strategy Profile using profile.dataRequirements (no name branching).
 */
async function fetchProfileHtfCandles(profile, symbol, options = {}) {
  if (!profile || profile.enabled === false) return [];
  const registry = getDefaultRegistry();
  const runner = registry.get(profile.id);
  if (runner && runner.enabled === false) return [];
  const field = profile.dataRequirements?.htfTimeframeField || 'htfTimeframe';
  const tf =
    runner?.config?.[field] ||
    profile.higherTimeframes?.[0] ||
    profile.dataRequirements?.defaultTimeframe ||
    '15m';
  return fetchHtfCandles(symbol, {
    ...options,
    timeframe: tf,
    force: true
  });
}

async function fetchScalpingHtfCandles(symbol, options = {}) {
  bootstrapStrategyProfiles();
  const profile = getProfileRegistry().getById(SCALPING_ID);
  return fetchProfileHtfCandles(profile, symbol, options);
}

async function processCandles(symbol, candles, io, options = {}) {
  if (candles.length < 3) {
    return { processed: false, reason: 'insufficient_candles' };
  }

  const key = bufferKey(symbol);
  const normalizedSymbol = normalizeSymbol(symbol);
  const timeframe = options.timeframe || '3m';
  const c3 = candles[candles.length - 1];

  // Pre-scan gate: Market Regime Filter (strategy-agnostic). Skip FVG/Entry/SL/TP when unsuitable.
  if (options.skipMarketRegime !== true) {
    const regime = await MarketRegimeService.evaluate(normalizedSymbol, timeframe, {
      candles,
      spread: options.spread,
      spreadPips: options.spreadPips,
      now: options.now,
      allowProviderFetch: false,
      skipCache: options.skipRegimeCache === true
    });
    if (!regime.shouldScan) {
      MarketRegimeService.logSkip(normalizedSymbol, timeframe, regime);
      return {
        processed: false,
        reason: 'market_regime_skip',
        regime: regime.regime,
        score: regime.score,
        reasons: regime.reasons
      };
    }
  }

  // processCandles is used by ingestCandle (TV bar inject) and scanSymbol (live hub).
  // Live HTF only when the caller already loaded primary bars via allowProviderFetch.
  const htfCandles = await fetchHtfCandles(normalizedSymbol, {
    allowProviderFetch: Boolean(options.allowProviderFetch)
  });
  const scalpingHtfCandles = await fetchScalpingHtfCandles(normalizedSymbol, {
    allowProviderFetch: Boolean(options.allowProviderFetch)
  });

  const marketBag = {
    symbol: normalizedSymbol,
    candles,
    htfCandles,
    daytradingHtfCandles: htfCandles,
    scalpingHtfCandles,
    htf4hCandles: htfCandles,
    timeframe
  };

  const pending = pendingSetups.get(key);
  if (pending) {
    bootstrapStrategyProfiles();
    const strategyId = pending.strategyId || DAYTRADING_ID;
    const engine = getScannerEngine({
      strategyRegistry: getDefaultRegistry()
    });
    const profile =
      getProfileRegistry().getById(strategyId) || getProfileRegistry().getByKey(strategyId);

    if (profile && profile.status === 'live') {
      const defaultTf =
        options.timeframe ||
        engine.getDefaultTimeframe(profile) ||
        profile.dataRequirements?.defaultTimeframe;

      let pendingResult = engine.continuePending(strategyId, candles, pending, marketBag, {
        contextOverrides: { timeframe: defaultTf, symbol: normalizedSymbol }
      });

      if (pendingResult.signal && pendingResult.entry) {
        pendingResult = {
          passed: true,
          stage: 'entry',
          entry: pendingResult.entry
        };
      } else if (pendingResult.stage === 'pending_retrace') {
        pendingResult = { stage: 'pending_retrace', pending: pendingResult.pending || pending };
      } else {
        pendingResult = {
          expired:
            pendingResult.stage === 'rejected' ||
            pendingResult.stage === 'filtered' ||
            pendingResult.reason === 'no_continue_pending' ||
            pendingResult.reason === 'unknown_or_stub_strategy',
          stage: pendingResult.stage,
          reason: pendingResult.reason
        };
      }

      if (pendingResult.expired) {
        pendingSetups.delete(key);
      } else if (pendingResult.passed && pendingResult.stage === 'entry' && shouldEmit(symbol, c3.time)) {
        pendingSetups.delete(key);
        await publishEntrySignal(io, normalizedSymbol, pendingResult.entry);
        return { processed: true, pattern: pendingResult.entry.pattern, stage: 'entry', via: 'pending_retrace' };
      }
    } else {
      // Drop pending setups from removed classic / unknown / stub strategies
      pendingSetups.delete(key);
    }
  }

  const result = PatternDetectionService.scanLastCandles(candles, undefined, normalizedSymbol, {
    htfCandles,
    scalpingHtfCandles,
    timeframe,
    allowScalpingFallback: true
  });

  if (result.pending) {
    pendingSetups.set(key, { ...result.pending, symbol: normalizedSymbol });
  } else if (!result.entry) {
    pendingSetups.delete(key);
  }

  if (result.entry && shouldEmit(symbol, c3.time)) {
    await publishEntrySignal(io, normalizedSymbol, result.entry);
    pendingSetups.delete(key);
    return { processed: true, pattern: result.entry.pattern, stage: 'entry' };
  }

  if (result.pending) {
    return {
      processed: false,
      stage: 'pending_retrace',
      pattern: result.pending?.pattern || result.strategyId || 'strategy_pending'
    };
  }

  return { processed: false };
}
async function ingestCandle(io, { symbol, ...ohlc }) {
  if (!symbol) {
    throw new Error('symbol is required');
  }

  const candles = appendCandle(symbol, ohlc);
  return processCandles(symbol, candles, io);
}

async function scanSymbol(_io, symbol) {
  // Live market data is chart-only. Do not fetch providers or publish signals here.
  return {
    processed: false,
    symbol: normalizeSymbol(symbol),
    reason: 'tradingview_only',
    message:
      'Trading signals are published exclusively via TradingView webhooks. Live market data is used only for chart candles.'
  };
}

async function runFullScan(_io) {
  return PATTERN_SCANNER_CONFIG.symbols.map(symbol => ({
    symbol,
    processed: false,
    reason: 'tradingview_only',
    message:
      'Scanner publishing is disabled. Signals arrive from TradingView webhooks only.'
  }));
}

async function runAutoScanTick(io) {
  const symbols = PATTERN_SCANNER_CONFIG.symbols || [];
  if (!symbols.length) return;

  const batchSize = Math.max(1, Number(PATTERN_SCANNER_CONFIG.scanBatchSize) || 5);
  const start = scanRotationIndex % symbols.length;
  const batch = [];
  for (let i = 0; i < batchSize && i < symbols.length; i += 1) {
    batch.push(symbols[(start + i) % symbols.length]);
  }
  scanRotationIndex = (start + batch.length) % symbols.length;

  // Internal rotation only — scanSymbol refuses provider-candle publish (TradingView-only signals).
  await Promise.allSettled(batch.map(symbol => scanSymbol(io, symbol)));
}

function startAutoScanner(io) {
  ioRef = io;
  // Chart/cache polling lives in MarketDataHubService and is unaffected.
  // Production signals still publish only via TradingView webhooks (publishEntrySignal is locked).
  if (autoScanTimer) {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
  }
  if (!PATTERN_SCANNER_CONFIG.autoScanEnabled) {
    console.log(
      '[Scanner] Auto-scan disabled — TradingView webhooks remain the sole signal source; ' +
        'live providers are chart-only'
    );
    return;
  }

  const intervalMs = Math.max(
    60_000,
    Number(PATTERN_SCANNER_CONFIG.autoScanIntervalMs) || 60_000
  );
  const tick = () => {
    runAutoScanTick(ioRef || io).catch(err => {
      console.error('[Scanner] Auto-scan tick error:', err.message);
    });
  };
  tick();
  autoScanTimer = setInterval(tick, intervalMs);
  console.log(
    `[Scanner] Auto-scan timer started (every ${intervalMs}ms) — ` +
      'internal rotation only; TradingView webhooks remain the sole signal publisher'
  );
}

function stopAutoScanner() {
  if (autoScanTimer) {
    clearInterval(autoScanTimer);
    autoScanTimer = null;
  }
}

async function buildAnalyzeEntry(symbol, detection, candles, interval) {
  return SignalEnrichmentService.enrichSignal(
    {
      symbol,
      direction: detection.direction,
      entry: detection.entry,
      stop_loss: detection.stop_loss,
      stop_loss_1: detection.stop_loss_1 ?? detection.stop_loss,
      take_profit_1: detection.take_profit_1,
      take_profit_2: detection.take_profit_2,
      take_profit_3: detection.take_profit_3,
      confidence: detection.confidence,
      notes: detection.notes,
      alertType: 'entry',
      pattern: detection.pattern,
      patternLabel: detection.patternLabel,
      gapTop: detection.gapTop,
      gapBottom: detection.gapBottom,
      pipelineSteps: detection.pipelineSteps,
      pipelineVersion: detection.pipelineVersion,
      pipelineScore: detection.pipelineScore,
      pipelineScoreBreakdown: detection.pipelineScoreBreakdown,
      signalQuality: detection.signalQuality,
      isPremiumSignal: detection.isPremiumSignal,
      source: 'live_scan',
      timeframe: interval
    },
    { candles, timeframe: interval }
  );
}

async function analyzeSymbol(symbol, interval = '1h') {
  const normalizedSymbol = normalizeSymbol(symbol);
  // Chart Entry/SL/TP overlays come from webhook-stored signals on the client.
  // This endpoint no longer recalculates setups from live provider candles.
  return {
    symbol: normalizedSymbol,
    interval,
    stage: 'webhook_distribution',
    entry: null,
    message:
      'Chart levels are drawn from TradingView webhook signals. Live market data providers are chart-only.'
  };
}

function getScannerStatus() {
  return {
    autoScanEnabled: Boolean(PATTERN_SCANNER_CONFIG.autoScanEnabled),
    autoScanRunning: Boolean(autoScanTimer),
    autoScanIntervalMs: PATTERN_SCANNER_CONFIG.autoScanIntervalMs,
    scanBatchSize: PATTERN_SCANNER_CONFIG.scanBatchSize,
    architecture: 'tradingview_webhook_distribution',
    signalPublication: 'tradingview_webhook',
    liveProviderRole: 'chart_candles_only',
    internalManualScan: {
      usesLiveMarketData: false,
      publishesSignals: false,
      endpoints: ['GET /api/scanner/analyze', 'POST /api/scanner/run'],
      note: 'Manual/analyze/run/auto-scan do not generate trading signals from providers'
    },
    tradingViewWebhook: {
      publishOnly: true,
      fetchesCandles: false,
      isSoleSignalSource: true
    },
    symbols: PATTERN_SCANNER_CONFIG.symbols,
    buffers: PATTERN_SCANNER_CONFIG.symbols.map(symbol => ({
      symbol,
      candles: getCandles(symbol).length,
      pendingRetrace: pendingSetups.has(bufferKey(symbol))
    })),
    strategies: getDefaultRegistry().list().map(s => ({
      id: s.id,
      name: s.name,
      enabled: s.enabled !== false
    })),
    patterns: ['liquidity_sweep_fvg_daytrading', 'liquidity_sweep_fvg_scalp']
  };
}

/**
 * TradingView webhook path (inject / publish only).
 * Validates + publishes alerts to sockets / Telegram / storage.
 * NEVER calls hub.getCandles, fetchHistoricalData, indicator, liquidity, or FVG pipelines.
 * Live market-data providers are chart-only — they must never generate trading signals.
 * Timer auto-scan may run for internal rotation; scanSymbol / analyzeSymbol / runFullScan do not publish.
 */
async function publishTradingViewAlert(io, rawBody, inMemorySignals = []) {
  return TradingViewService.publishWebhookEvent(io, rawBody, inMemorySignals);
}

async function processTradingViewWebhook(io, rawBody, inMemorySignals = []) {
  return publishTradingViewAlert(io, rawBody, inMemorySignals);
}

module.exports = {
  ingestCandle,
  scanSymbol,
  analyzeSymbol,
  runFullScan,
  startAutoScanner,
  stopAutoScanner,
  getScannerStatus,
  getCandles,
  publishTradingViewAlert,
  processTradingViewWebhook
};
