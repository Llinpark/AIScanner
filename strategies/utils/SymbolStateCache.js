/**
 * Per-symbol incremental cache: swings, session H/L, last processed indices.
 * Avoids full historical recalculation on every bar for 100+ symbols.
 */

const { findSwingPoints } = require('./candleMath');
const { computeSessionLevels } = require('./sessionLevels');

class SymbolStateCache {
  constructor() {
    /** @type {Map<string, Object>} */
    this.states = new Map();
  }

  /**
   * @param {string} symbol
   * @param {string} timeframe
   */
  key(symbol, timeframe) {
    return `${String(symbol).toUpperCase()}::${timeframe}`;
  }

  get(symbol, timeframe) {
    return this.states.get(this.key(symbol, timeframe)) || null;
  }

  /**
   * Upsert candle buffer + refresh swings / sessions only for newly confirmed bars.
   * @param {string} symbol
   * @param {string} timeframe
   * @param {import('../types').Candle[]} candles
   * @param {Object} config - scalping config
   */
  update(symbol, timeframe, candles, config) {
    const k = this.key(symbol, timeframe);
    let state = this.states.get(k);
    if (!state) {
      state = {
        symbol,
        timeframe,
        lastLen: 0,
        swingLows: [],
        swingHighs: [],
        sessionLevels: null,
        pools: [],
        lastSweep: null,
        pendingSetup: null
      };
      this.states.set(k, state);
    }

    const window = config.swing?.sensitivity || 2;
    const maxBars =
      timeframe === (config.htfTimeframe || '15m')
        ? config.cache?.maxCandlesHtf || 120
        : config.cache?.maxCandlesLtf || 180;

    // Truncate view for memory — callers pass already-normalized arrays
    const view = candles.length > maxBars ? candles.slice(-maxBars) : candles;

    if (view.length !== state.lastLen || view.length < state.lastLen) {
      // Length change (or reset): rescan swings from a safe lookback, not full history from 0
      // when we already have swings — but simplest correct path for truncate is rescan.
      const lookback = Math.min(view.length, config.swing?.lookbackBars || 48);
      const slice = view.slice(-lookback);
      const offset = view.length - slice.length;
      const { swingLows, swingHighs } = findSwingPoints(slice, window, 0);
      state.swingLows = swingLows.map(s => ({
        ...s,
        index: offset + s.index
      }));
      state.swingHighs = swingHighs.map(s => ({
        ...s,
        index: offset + s.index
      }));
      state.sessionLevels = computeSessionLevels(view, config.sessions);
      state.lastLen = view.length;
      state.candlesRef = view;
    }

    return state;
  }

  clear(symbol, timeframe) {
    if (timeframe) this.states.delete(this.key(symbol, timeframe));
    else {
      const prefix = `${String(symbol).toUpperCase()}::`;
      for (const k of this.states.keys()) {
        if (k.startsWith(prefix)) this.states.delete(k);
      }
    }
  }

  clearAll() {
    this.states.clear();
  }
}

/** Shared singleton for scanner wiring */
const globalSymbolStateCache = new SymbolStateCache();

module.exports = {
  SymbolStateCache,
  globalSymbolStateCache
};
