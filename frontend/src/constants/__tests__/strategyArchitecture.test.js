import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGY_ARCHITECTURE,
  FUTURE_STRATEGY_KEYS,
  getStrategyArchitecture,
  formatEntryHtfLine
} from '../strategyArchitecture.js';
import { SCALPING_STRATEGY_DEFAULTS } from '../scalpingDefaults.js';
import { DAYTRADING_STRATEGY_DEFAULTS } from '../dayTradingDefaults.js';

describe('frontend Strategy Architecture', () => {
  it('matches Scalping / Day Trading canonical TFs', () => {
    assert.deepEqual([...STRATEGY_ARCHITECTURE.scalping.entryTimeframes], ['3m', '5m']);
    assert.deepEqual([...STRATEGY_ARCHITECTURE.scalping.htfTimeframes], ['15m']);
    assert.ok(!STRATEGY_ARCHITECTURE.scalping.entryTimeframes.includes('1m'));
    assert.deepEqual([...STRATEGY_ARCHITECTURE.daytrading.entryTimeframes], ['5m', '15m']);
    assert.deepEqual([...STRATEGY_ARCHITECTURE.daytrading.htfTimeframes], ['1h', '4h']);
  });

  it('restore packs stay aligned with architecture', () => {
    assert.deepEqual(
      [...SCALPING_STRATEGY_DEFAULTS.entryTimeframes],
      [...STRATEGY_ARCHITECTURE.scalping.entryTimeframes]
    );
    assert.deepEqual(
      [...DAYTRADING_STRATEGY_DEFAULTS.entryTimeframes],
      [...STRATEGY_ARCHITECTURE.daytrading.entryTimeframes]
    );
    assert.equal(
      SCALPING_STRATEGY_DEFAULTS.htfTimeframe,
      STRATEGY_ARCHITECTURE.scalping.defaultHtfTimeframe
    );
    assert.equal(
      DAYTRADING_STRATEGY_DEFAULTS.htfTimeframe,
      STRATEGY_ARCHITECTURE.daytrading.defaultHtfTimeframe
    );
  });

  it('exposes chart hints and future slots', () => {
    assert.match(getStrategyArchitecture('scalping').chartHint, /3m or 5m/);
    assert.match(getStrategyArchitecture('scalping').chartHint, /Day Trading/);
    assert.match(getStrategyArchitecture('daytrading').chartHint, /1H or 4H/);
    assert.match(getStrategyArchitecture('daytrading').chartHint, /15m/);
    assert.match(formatEntryHtfLine('scalping'), /Entry Timeframe/);
    assert.ok(FUTURE_STRATEGY_KEYS.includes('swing'));
  });
});
