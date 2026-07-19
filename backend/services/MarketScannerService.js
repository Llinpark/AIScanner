const TradingViewAlertService = require('./TradingViewAlertService');
const SignalEnrichmentService = require('./SignalEnrichmentService');
const PatternDetectionService = require('./PatternDetectionService');
const TradingPipelineService = require('./TradingPipelineService');
const { getMarketDataHub } = require('./MarketDataHubService');
const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const { normalizeSymbol } = require('../config/symbols');
const {
  chartLevelKey,
  detectTradeOutcome,
  attachActivation
} = require('../utils/tradeLevelLifecycle');

const candleBuffers = new Map();
const lastEmittedBar = new Map();
const pendingSetups = new Map();
const activeChartLevels = new Map();
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

function storeActiveChartLevel(symbol, interval, entry, barTime) {
  const key = chartLevelKey(symbol, interval);
  activeChartLevels.set(key, attachActivation(entry, barTime));
}

function getActiveChartLevel(symbol, interval) {
  return activeChartLevels.get(chartLevelKey(symbol, interval)) || null;
}

function clearActiveChartLevel(symbol, interval) {
  activeChartLevels.delete(chartLevelKey(symbol, interval));
}

function resolveActiveLevelOutcome(symbol, interval, candles) {
  const active = getActiveChartLevel(symbol, interval);
  if (!active) return { active: null, closed: null };

  const hit = detectTradeOutcome(active, candles);
  if (!hit) return { active, closed: null };

  clearActiveChartLevel(symbol, interval);
  return {
    active: null,
    closed: {
      ...active,
      outcome: hit.outcome,
      outcomeR: hit.outcomeR,
      tradeStatus: hit.outcome === 'sl' ? 'lost' : 'won',
      closedAt: new Date().toISOString()
    }
  };
}

async function publishEntrySignal(io, symbol, detection) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const candles = getCandles(normalizedSymbol);
  const payload = await SignalEnrichmentService.enrichSignal(
    {
      symbol: normalizedSymbol,
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
      source: 'pattern_scanner',
      broadcast: true,
      timeframe: '1h'
    },
    { candles, timeframe: '1h' }
  );

  const barTime = candles.length ? candles[candles.length - 1].time : Date.now();
  storeActiveChartLevel(normalizedSymbol, '1h', payload, barTime);

  const saved = await TradingViewAlertService.saveSignal({ ...payload, isBroadcast: true });

  io.emit('signal:update', saved);
  io.emit('scanner:entry', {
    symbol: normalizedSymbol,
    pattern: detection.pattern,
    patternLabel: detection.patternLabel,
    direction: detection.direction,
    ...payload
  });

  await TradingViewAlertService.broadcastToSubscribers(io, payload, [], { existingSaved: saved });

  console.log(
    `[Scanner] PREMIUM ENTRY ${detection.pattern} ${normalizedSymbol} ${detection.direction} @ ${detection.entry} (score ${detection.pipelineScore}%)`
  );
  return saved;
}

async function fetchHtfCandles(symbol) {
  if (!PATTERN_SCANNER_CONFIG.pipeline?.enabled) return [];

  const htfTimeframe = PATTERN_SCANNER_CONFIG.pipeline.htf?.timeframe || '4h';
  try {
    const hub = getMarketDataHub();
    let payload = await hub.getCandles(symbol, htfTimeframe, 60, { cacheOnly: true });
    if (!payload?.candles?.length) {
      payload = await hub.getCandles(symbol, htfTimeframe, 60, { allowProviderFetch: true });
    }
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

async function processCandles(symbol, candles, io) {
  if (candles.length < 3) {
    return { processed: false, reason: 'insufficient_candles' };
  }

  const key = bufferKey(symbol);
  const normalizedSymbol = normalizeSymbol(symbol);
  const c3 = candles[candles.length - 1];
  const htfCandles = await fetchHtfCandles(normalizedSymbol);

  const pending = pendingSetups.get(key);
  if (pending) {
    const pendingResult = TradingPipelineService.checkPendingRetracement(candles, pending, {
      symbol: normalizedSymbol,
      htfCandles
    });

    if (pendingResult.expired) {
      pendingSetups.delete(key);
    } else if (pendingResult.passed && pendingResult.stage === 'entry' && shouldEmit(symbol, c3.time)) {
      pendingSetups.delete(key);
      await publishEntrySignal(io, normalizedSymbol, pendingResult.entry);
      return { processed: true, pattern: pendingResult.entry.pattern, stage: 'entry', via: 'pending_retrace' };
    } else if (pendingResult.stage === 'below_premium_threshold') {
      pendingSetups.delete(key);
      return {
        processed: false,
        stage: 'below_premium_threshold',
        pipelineScore: pendingResult.pipelineScore
      };
    }
  }

  const result = PatternDetectionService.scanLastCandles(candles, undefined, normalizedSymbol, {
    htfCandles
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

  if (result.pipeline?.stage === 'below_premium_threshold' || result.stage === 'below_premium_threshold') {
    return {
      processed: false,
      stage: 'below_premium_threshold',
      pipelineScore: result.pipelineScore ?? result.pipeline?.pipelineScore
    };
  }

  if (result.pending) {
    return { processed: false, stage: 'pending_retrace', pattern: 'smc_pipeline' };
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

async function scanSymbol(io, symbol) {
  const hub = getMarketDataHub();
  const payload = await hub.getCandles(symbol, '1h', 100, { allowProviderFetch: true });
  const normalized = (payload.candles || [])
    .map(c => PatternDetectionService.normalizeCandle({
      time: Date.parse(c.timestamp),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume
    }))
    .sort((a, b) => a.time - b.time);

  candleBuffers.set(bufferKey(symbol), normalized);
  return processCandles(symbol, normalized, io);
}

async function runFullScan(io) {
  const symbols = PATTERN_SCANNER_CONFIG.symbols;
  const batchSize = PATTERN_SCANNER_CONFIG.scanBatchSize || 2;
  const batch = [];

  for (let i = 0; i < batchSize; i += 1) {
    batch.push(symbols[(scanRotationIndex + i) % symbols.length]);
  }
  scanRotationIndex = (scanRotationIndex + batchSize) % symbols.length;

  const results = [];
  for (const symbol of batch) {
    try {
      const result = await scanSymbol(io, symbol);
      results.push({ symbol, ...result });
    } catch (error) {
      results.push({ symbol, error: error.message });
    }
  }
  return results;
}

function startAutoScanner(io) {
  ioRef = io;
  if (!PATTERN_SCANNER_CONFIG.autoScanEnabled || autoScanTimer) {
    return;
  }

  autoScanTimer = setInterval(() => {
    runFullScan(io).catch(err => console.error('[Scanner] auto-scan error:', err.message));
  }, PATTERN_SCANNER_CONFIG.autoScanIntervalMs);

  console.log(`[Scanner] Auto-scan every ${PATTERN_SCANNER_CONFIG.autoScanIntervalMs}ms`);
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
  const hub = getMarketDataHub();
  const payload = await hub.getCandles(normalizedSymbol, interval, 100, { allowProviderFetch: true });
  const candles = (payload.candles || [])
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

  if (candles.length < 3) {
    const { active, closed } = resolveActiveLevelOutcome(normalizedSymbol, interval, candles);
    return {
      symbol: normalizedSymbol,
      interval,
      stage: closed ? 'closed' : active ? 'active_trade' : 'insufficient_candles',
      entry: active,
      closedLevel: closed,
      outcome: closed?.outcome || null,
      candleCount: candles.length
    };
  }

  const htfCandles = await fetchHtfCandles(normalizedSymbol);
  const key = bufferKey(normalizedSymbol);
  const c3 = candles[candles.length - 1];

  const { active: existingActive, closed: closedLevel } = resolveActiveLevelOutcome(
    normalizedSymbol,
    interval,
    candles
  );

  if (closedLevel) {
    return {
      symbol: normalizedSymbol,
      interval,
      stage: 'closed',
      entry: null,
      closedLevel,
      outcome: closedLevel.outcome,
      barTime: c3.time
    };
  }

  let activeLevel = existingActive;

  if (interval === '1h') {
    const pending = pendingSetups.get(key);
    if (pending) {
      const pendingResult = TradingPipelineService.checkPendingRetracement(candles, pending, {
        symbol: normalizedSymbol,
        htfCandles
      });

      if (pendingResult.passed && pendingResult.stage === 'entry') {
        const entry = await buildAnalyzeEntry(normalizedSymbol, pendingResult.entry, candles, interval);
        storeActiveChartLevel(normalizedSymbol, interval, entry, c3.time);
        return {
          symbol: normalizedSymbol,
          interval,
          stage: 'entry',
          via: 'pending_retrace',
          entry,
          barTime: c3.time
        };
      }
    }
  }

  const result = PatternDetectionService.scanLastCandles(candles, undefined, normalizedSymbol, {
    htfCandles
  });

  if (result.entry) {
    const entry = await buildAnalyzeEntry(normalizedSymbol, result.entry, candles, interval);
    storeActiveChartLevel(normalizedSymbol, interval, entry, c3.time);
    return {
      symbol: normalizedSymbol,
      interval,
      stage: 'entry',
      entry,
      pipelineScore: result.entry.pipelineScore ?? result.pipeline?.pipelineScore,
      barTime: c3.time
    };
  }

  if (activeLevel) {
    return {
      symbol: normalizedSymbol,
      interval,
      stage: 'active_trade',
      entry: activeLevel,
      barTime: c3.time
    };
  }

  if (result.pending) {
    return {
      symbol: normalizedSymbol,
      interval,
      stage: 'pending_retrace',
      pending: {
        pattern: result.pending.pattern,
        direction: result.pending.direction,
        gapTop: result.pending.gapTop,
        gapBottom: result.pending.gapBottom
      },
      entry: null,
      barTime: c3.time
    };
  }

  if (result.stage === 'below_premium_threshold' || result.pipeline?.stage === 'below_premium_threshold') {
    return {
      symbol: normalizedSymbol,
      interval,
      stage: 'below_premium_threshold',
      pipelineScore: result.pipelineScore ?? result.pipeline?.pipelineScore,
      entry: null,
      barTime: c3.time
    };
  }

  return {
    symbol: normalizedSymbol,
    interval,
    stage: result.pipeline?.stage || 'no_setup',
    entry: null,
    barTime: c3.time
  };
}

function getScannerStatus() {
  return {
    autoScanEnabled: PATTERN_SCANNER_CONFIG.autoScanEnabled,
    autoScanIntervalMs: PATTERN_SCANNER_CONFIG.autoScanIntervalMs,
    scanBatchSize: PATTERN_SCANNER_CONFIG.scanBatchSize,
    symbols: PATTERN_SCANNER_CONFIG.symbols,
    buffers: PATTERN_SCANNER_CONFIG.symbols.map(symbol => ({
      symbol,
      candles: getCandles(symbol).length,
      pendingRetrace: pendingSetups.has(bufferKey(symbol))
    })),
    pipeline: {
      enabled: PATTERN_SCANNER_CONFIG.pipeline?.enabled !== false,
      steps: TradingPipelineService.PIPELINE_STEPS,
      htfTimeframe: PATTERN_SCANNER_CONFIG.pipeline?.htf?.timeframe || '4h',
      premiumThreshold: PATTERN_SCANNER_CONFIG.pipeline?.scoring?.premiumThreshold || 90
    },
    patterns: ['smc_pipeline']
  };
}

module.exports = {
  ingestCandle,
  scanSymbol,
  analyzeSymbol,
  runFullScan,
  startAutoScanner,
  stopAutoScanner,
  getScannerStatus,
  getCandles
};
