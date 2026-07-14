const TradingViewService = require('./TradingViewService');
const TradingViewAlertService = require('./TradingViewAlertService');
const SignalEnrichmentService = require('./SignalEnrichmentService');
const PatternDetectionService = require('./PatternDetectionService');
const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const { normalizeSymbol } = require('../config/symbols');

const candleBuffers = new Map();
const lastEmittedBar = new Map();

let autoScanTimer = null;
let ioRef = null;

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
      source: 'pattern_scanner',
      broadcast: true,
      timeframe: '1h'
    },
    { candles, timeframe: '1h' }
  );

  const saved = await TradingViewAlertService.saveSignal(payload);

  io.emit('signal:update', saved);
  io.emit('scanner:entry', {
    symbol: normalizedSymbol,
    pattern: detection.pattern,
    patternLabel: detection.patternLabel,
    direction: detection.direction,
    ...payload
  });

  await TradingViewAlertService.broadcastToSubscribers(io, payload);

  console.log(`[Scanner] ENTRY ${detection.pattern} ${normalizedSymbol} ${detection.direction} @ ${detection.entry}`);
  return saved;
}

function processCandles(symbol, candles, io) {
  if (candles.length < 3) {
    return { processed: false, reason: 'insufficient_candles' };
  }

  const c3 = candles[candles.length - 1];
  const result = PatternDetectionService.scanLastCandles(candles, undefined, symbol);

  if (result.entry && shouldEmit(symbol, c3.time)) {
    publishEntrySignal(io, symbol, result.entry);
    return { processed: true, pattern: result.entry.pattern, stage: 'entry' };
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
  const historical = await TradingViewService.getHistoricalData(symbol, '1h', 100);
  const normalized = historical
    .map(c => PatternDetectionService.normalizeCandle(c))
    .sort((a, b) => a.time - b.time);

  candleBuffers.set(bufferKey(symbol), normalized);
  return processCandles(symbol, normalized, io);
}

async function runFullScan(io) {
  const results = [];
  for (const symbol of PATTERN_SCANNER_CONFIG.symbols) {
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

function getScannerStatus() {
  return {
    autoScanEnabled: PATTERN_SCANNER_CONFIG.autoScanEnabled,
    autoScanIntervalMs: PATTERN_SCANNER_CONFIG.autoScanIntervalMs,
    symbols: PATTERN_SCANNER_CONFIG.symbols,
    buffers: PATTERN_SCANNER_CONFIG.symbols.map(symbol => ({
      symbol,
      candles: getCandles(symbol).length
    })),
    patterns: ['perfect_fvg', 'breakaway_gap']
  };
}

module.exports = {
  ingestCandle,
  scanSymbol,
  runFullScan,
  startAutoScanner,
  stopAutoScanner,
  getScannerStatus,
  getCandles
};
