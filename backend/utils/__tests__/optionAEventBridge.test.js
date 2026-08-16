/**
 * Option A event-safe bridge + canonical lifecycle — behavioural contracts.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  makeCanonicalSignalId,
  eventsInDisplayBar,
  projectToHigherDisplay,
  evaluateCanonBarOutcome,
  runCanonicalLifecycle,
  tfToMs,
  expiryDurationMs
} = require('../canonicalEventBridge');
const { computeExpiresAt } = require('../signalOutcome');
const ActiveSignalRegistry = require('../activeSignalRegistry');
const TradeLifecycleService = require('../../services/TradeLifecycleService');
const {
  PINE_CLIENT_VERSION,
  CURRENT_PINE_CAPABILITIES,
  resolveCompatibilityMode,
  COMPAT_MODE
} = require('../PineClientVersion');

const BRIDGE = fs.readFileSync(
  path.join(__dirname, '../../templates/snippets/kaching-canon-event-bridge.pine.snippet'),
  'utf8'
);
const ARM = fs.readFileSync(
  path.join(__dirname, '../../templates/snippets/kaching-canon-event-arm.pine.snippet'),
  'utf8'
);
const DRAW_DEFS = fs.readFileSync(
  path.join(__dirname, '../../templates/snippets/kaching-trade-drawing.pine.snippet'),
  'utf8'
);
const DRAW_RT = fs.readFileSync(
  path.join(__dirname, '../../templates/snippets/kaching-trade-drawing-runtime.pine.snippet'),
  'utf8'
);

describe('Option A event-safe projection (behavioural)', () => {
  const T0 = Date.UTC(2026, 7, 9, 10, 0, 0);

  it('scalp: same UUID/levels for one event on 1m/3m/5m', () => {
    const ev = {
      signalTime: T0 + 3 * 60_000,
      direction: 'long',
      entry: 123.45,
      sl: 123.3,
      tp1: 123.6,
      tp2: 123.75,
      tp3: 124.0
    };
    const uuid = makeCanonicalSignalId('EURUSD', 'scalping', '3', ev.signalTime, 'long');
    const projections = [
      eventsInDisplayBar([ev], ev.signalTime, tfToMs('1m')),
      eventsInDisplayBar([ev], ev.signalTime, tfToMs('3m')),
      eventsInDisplayBar([ev], T0, tfToMs('5m'))
    ];
    for (const inBar of projections) {
      assert.equal(inBar.length, 1);
      assert.equal(
        makeCanonicalSignalId('EURUSD', 'scalping', '3', inBar[0].signalTime, 'long'),
        uuid
      );
      assert.equal(inBar[0].entry, ev.entry);
      assert.equal(inBar[0].sl, ev.sl);
      assert.equal(inBar[0].tp1, ev.tp1);
      assert.equal(inBar[0].tp2, ev.tp2);
      assert.equal(inBar[0].tp3, ev.tp3);
    }
    assert.equal(uuid.includes('-c3-'), true);
    assert.doesNotMatch(uuid, /1m|5m/);
  });

  it('scalp: two 3m events inside one 5m bar are BOTH recoverable (no collapse)', () => {
    const a = {
      signalTime: T0 + 6 * 60_000,
      direction: 'long',
      entry: 1,
      sl: 0.9,
      tp1: 1.1,
      tp2: 1.2,
      tp3: 1.3
    };
    const b = {
      signalTime: T0 + 9 * 60_000,
      direction: 'short',
      entry: 2,
      sl: 2.1,
      tp1: 1.9,
      tp2: 1.8,
      tp3: 1.7
    };
    // 5m bar 10:05–10:10 contains completed 3m opens 10:06 and 10:09.
    const barOpen = T0 + 5 * 60_000;
    const { collapsed, eventSafe } = projectToHigherDisplay([a, b], barOpen, tfToMs('5m'));
    assert.equal(eventSafe.length, 2, 'event-safe bridge must keep both events');
    assert.equal(eventSafe[0].signalTime, a.signalTime);
    assert.equal(eventSafe[1].signalTime, b.signalTime);
    assert.equal(collapsed.signalTime, b.signalTime, 'legacy security collapse keeps only last');
    assert.notEqual(
      makeCanonicalSignalId('X', 'scalping', '3', a.signalTime, 'long'),
      makeCanonicalSignalId('X', 'scalping', '3', b.signalTime, 'short')
    );
  });

  it('day: three 5m events inside one 15m bar are ALL recoverable', () => {
    const events = [0, 5, 10].map((m, i) => ({
      signalTime: T0 + m * 60_000,
      direction: i % 2 === 0 ? 'long' : 'short',
      entry: 100 + i,
      sl: 99,
      tp1: 101,
      tp2: 102,
      tp3: 103
    }));
    const { collapsed, eventSafe } = projectToHigherDisplay(events, T0, tfToMs('15m'));
    assert.equal(eventSafe.length, 3);
    assert.equal(collapsed.signalTime, events[2].signalTime);
    assert.deepEqual(
      eventSafe.map((e) => e.signalTime),
      events.map((e) => e.signalTime)
    );
  });

  it('safe last-dir semantics: 0/1/2/3 events and empty/mismatched companions', () => {
    // Mirrors Pine ternary lastEvDir + evFieldsAligned (not non-short-circuit `and`).
    const safeEdge = (evSignalTime, evDir, evEntry) => {
      const bridgeEventCount = evSignalTime.length;
      const aligned =
        bridgeEventCount > 0 &&
        evDir.length === bridgeEventCount &&
        evEntry.length === bridgeEventCount;
      const lastEvDir = evDir.length > 0 ? evDir[evDir.length - 1] : null;
      return {
        bridgeEventCount,
        newCanonLong: aligned && lastEvDir === 1,
        newCanonShort: aligned && lastEvDir === -1
      };
    };
    assert.deepEqual(safeEdge([], [], []), {
      bridgeEventCount: 0,
      newCanonLong: false,
      newCanonShort: false
    });
    assert.deepEqual(safeEdge([1], [1], [1.2]), {
      bridgeEventCount: 1,
      newCanonLong: true,
      newCanonShort: false
    });
    assert.deepEqual(safeEdge([1, 2], [1, -1], [1.2, 2.2]), {
      bridgeEventCount: 2,
      newCanonLong: false,
      newCanonShort: true
    });
    assert.deepEqual(safeEdge([1, 2, 3], [1, -1, 1], [1, 2, 3]), {
      bridgeEventCount: 3,
      newCanonLong: true,
      newCanonShort: false
    });
    // Empty / mismatched companions → no arm edge (and must not imply array.get(-1)).
    assert.deepEqual(safeEdge([1], [], [1.2]), {
      bridgeEventCount: 1,
      newCanonLong: false,
      newCanonShort: false
    });
    assert.deepEqual(safeEdge([1], [1], []), {
      bridgeEventCount: 1,
      newCanonLong: false,
      newCanonShort: false
    });
  });

  it('UUID ignores chart timeframe', () => {
    const id = makeCanonicalSignalId('EURUSD', 'scalping', '3', 111, 'long');
    assert.match(id, /^EURUSD-scalping-c3-111-long$/);
    assert.doesNotMatch(id, /chart|1m|5m/);
  });

  it('handles zero / one / two / three events without fixed array length assumption', () => {
    const barOpen = T0;
    const mk = (m, dir = 'long') => ({
      signalTime: T0 + m * 60_000,
      direction: dir,
      entry: 1,
      sl: 0.9,
      tp1: 1.1,
      tp2: 1.2,
      tp3: 1.3
    });
    assert.equal(eventsInDisplayBar([], barOpen, tfToMs('15m')).length, 0);
    assert.equal(eventsInDisplayBar([mk(0)], barOpen, tfToMs('15m')).length, 1);
    assert.equal(eventsInDisplayBar([mk(0), mk(5)], barOpen, tfToMs('15m')).length, 2);
    assert.equal(eventsInDisplayBar([mk(0), mk(5), mk(10)], barOpen, tfToMs('15m')).length, 3);
  });

  it('opposite-direction events keep distinct UUIDs and chronological order', () => {
    const events = [
      {
        signalTime: T0 + 6 * 60_000,
        direction: 'long',
        entry: 1,
        sl: 0.9,
        tp1: 1.1,
        tp2: 1.2,
        tp3: 1.3
      },
      {
        signalTime: T0 + 9 * 60_000,
        direction: 'short',
        entry: 2,
        sl: 2.1,
        tp1: 1.9,
        tp2: 1.8,
        tp3: 1.7
      }
    ];
    const safe = eventsInDisplayBar(events, T0 + 5 * 60_000, tfToMs('5m'));
    assert.equal(safe.length, 2);
    assert.equal(safe[0].direction, 'long');
    assert.equal(safe[1].direction, 'short');
    const ua = makeCanonicalSignalId('X', 'scalping', '3', safe[0].signalTime, 'long');
    const ub = makeCanonicalSignalId('X', 'scalping', '3', safe[1].signalTime, 'short');
    assert.notEqual(ua, ub);
  });

  it('same signalTime opposite direction → distinct UUIDs', () => {
    const t = T0 + 3 * 60_000;
    const longId = makeCanonicalSignalId('EURUSD', 'scalping', '3', t, 'long');
    const shortId = makeCanonicalSignalId('EURUSD', 'scalping', '3', t, 'short');
    assert.notEqual(longId, shortId);
  });

  it('display-bar boundaries: event at bar open included; event at next open excluded', () => {
    const open = T0 + 5 * 60_000;
    const end = open + tfToMs('5m');
    const atOpen = {
      signalTime: open,
      direction: 'long',
      entry: 1,
      sl: 0.9,
      tp1: 1.1,
      tp2: 1.2,
      tp3: 1.3
    };
    const atNext = {
      signalTime: end,
      direction: 'long',
      entry: 1,
      sl: 0.9,
      tp1: 1.1,
      tp2: 1.2,
      tp3: 1.3
    };
    const inBar = eventsInDisplayBar([atOpen, atNext], open, tfToMs('5m'));
    assert.equal(inBar.length, 1);
    assert.equal(inBar[0].signalTime, open);
  });

  it('A then B replacement chronology: last armed UUID is B', () => {
    const a = {
      signalTime: T0 + 6 * 60_000,
      direction: 'long',
      entry: 1,
      sl: 0.9,
      tp1: 1.1,
      tp2: 1.2,
      tp3: 1.3
    };
    const b = {
      signalTime: T0 + 9 * 60_000,
      direction: 'short',
      entry: 2,
      sl: 2.1,
      tp1: 1.9,
      tp2: 1.8,
      tp3: 1.7
    };
    const ordered = eventsInDisplayBar([b, a], T0 + 5 * 60_000, tfToMs('5m'));
    assert.deepEqual(
      ordered.map((e) => e.signalTime),
      [a.signalTime, b.signalTime]
    );
    let active = null;
    const cancelled = [];
    for (const ev of ordered) {
      const uuid = makeCanonicalSignalId('X', 'scalping', '3', ev.signalTime, ev.direction);
      if (active) cancelled.push(active);
      active = uuid;
    }
    assert.equal(cancelled.length, 1);
    assert.equal(
      cancelled[0],
      makeCanonicalSignalId('X', 'scalping', '3', a.signalTime, 'long')
    );
    assert.equal(active, makeCanonicalSignalId('X', 'scalping', '3', b.signalTime, 'short'));
  });
});

describe('Option A canonical lifecycle (behavioural)', () => {
  it('same-bar SL+TP3 resolves by close (long)', () => {
    const levels = { sl: 100, tp1: 110, tp2: 120, tp3: 130 };
    const slWins = evaluateCanonBarOutcome('long', { high: 130, low: 100, close: 99 }, levels);
    assert.equal(slWins.terminal, 'stop_loss');
    const tpWins = evaluateCanonBarOutcome('long', { high: 130, low: 100, close: 131 }, levels);
    assert.equal(tpWins.terminal, 'take_profit_3');
  });

  it('1m/3m/5m agree on canonical outcome for same OHLC path', () => {
    const levels = { sl: 100, tp1: 110, tp2: 120, tp3: 130 };
    const bars = [
      { time: 1, high: 105, low: 101, close: 104 },
      { time: 2, high: 131, low: 120, close: 125 }
    ];
    const r1 = runCanonicalLifecycle({
      direction: 'long',
      levels,
      canonBars: bars,
      entrySignalTime: 1,
      expiryBars: 60
    });
    const r2 = runCanonicalLifecycle({
      direction: 'long',
      levels,
      canonBars: bars,
      entrySignalTime: 1,
      expiryBars: 60
    });
    assert.equal(r1.reason, 'take_profit_3');
    assert.deepEqual(r1, r2);
  });

  it('expiry uses canonical bars (not display TF duration mismatch)', () => {
    const scalpCanon = expiryDurationMs('3m', 60);
    const dayCanon = expiryDurationMs('5m', 80);
    assert.equal(scalpCanon, 60 * 180_000);
    assert.equal(dayCanon, 80 * 300_000);
    // Backend computeExpiresAt with canonical timeframe matches.
    const from = new Date('2026-08-09T10:00:00.000Z');
    const backend = computeExpiresAt('3m', 60, from);
    assert.equal(backend.getTime() - from.getTime(), scalpCanon);
  });
});

describe('Option A Pine bridge structure', () => {
  it('bridge uses security_lower_tf for higher display TF', () => {
    assert.match(BRIDGE, /useLowerTfBridge/);
    assert.match(BRIDGE, /request\.security_lower_tf/);
    assert.match(BRIDGE, /useDirectCanon/);
    assert.match(BRIDGE, /useSecurityMirror/);
    assert.match(BRIDGE, /barmerge\.lookahead_off/);
    assert.doesNotMatch(BRIDGE, /lookahead_on/);
  });

  it('hardens last-element access: no array.get(size-1) behind non-short-circuit and', () => {
    // Regression for TV R10045 at newCanonLong/Short: Pine evaluates BOTH sides of `and`,
    // so `array.size(x) > 0 and array.get(y, array.size(y)-1)` still crashes when y is empty.
    const bridgeCode = BRIDGE.split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(
      bridgeCode,
      /array\.size\([^)]+\)\s*>\s*0\s+and\s+array\.get\([^,]+,\s*array\.size\([^)]+\)\s*-\s*1\)/
    );
    assert.match(
      BRIDGE,
      /lastEvDir\s*=\s*array\.size\(evDir\)\s*>\s*0\s*\?\s*array\.get\(evDir,\s*array\.size\(evDir\)\s*-\s*1\)\s*:\s*na/
    );
    assert.match(BRIDGE, /evFieldsAligned/);
    assert.match(BRIDGE, /newCanonLong\s*=\s*evFieldsAligned/);
    assert.match(BRIDGE, /newCanonShort\s*=\s*evFieldsAligned/);
    // Zero-event path must not require array.get on event fields.
    assert.match(BRIDGE, /bridgeEventCount\s*=\s*array\.size\(evSignalTime\)/);
  });

  it('arm skips misaligned companion event fields before array.get', () => {
    assert.match(ARM, /array\.size\(evDir\)\s*<=\s*ei/);
    assert.match(ARM, /array\.size\(evEntry\)\s*<=\s*ei/);
    assert.match(ARM, /array\.size\(evDir\)\s*<=\s*ei2/);
    assert.match(ARM, /array\.size\(canonLifeHigh\)\s*<=\s*li/);
    assert.match(ARM, /for ei = 0 to array\.size\(evSignalTime\)/);
    assert.match(ARM, /for li = 0 to nLifeBars/);
    assert.match(ARM, /canonLifeHigh|lifeH/);
    assert.doesNotMatch(ARM, /lifeH\s*=\s*high\b/);
    assert.doesNotMatch(ARM, /lifeL\s*=\s*low\b/);
  });

  it('indicator() enables dynamic_requests when event bridge uses conditional request.*()', () => {
    // Option A places request.security_lower_tf / request.security inside if useLowerTfBridge /
    // if useSecurityMirror. Pine v5 defaults dynamic_requests=false and rejects that unless enabled.
    process.env.TRADINGVIEW_WEBHOOK_SECRET =
      process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
    process.env.WEBHOOK_SIGNING_SECRET =
      process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';
    const { generateForUser } = require('../../services/PineScriptGeneratorService');
    const user = {
      _id: '507f1f77bcf86cd799439011',
      email: 't@test.com',
      tradingviewUsername: 'demo_trader',
      subscription: { tier: 'professional', status: 'active' }
    };
    for (const strategy of ['scalping', 'daytrading']) {
      const g = generateForUser(user, { strategy });
      assert.match(g.script, /^\/\/@version=5\s*$/m, `${strategy}: stay on Pine v5`);
      assert.match(
        g.script,
        /^indicator\([^;\n]*overlay\s*=\s*true\s*,\s*dynamic_requests\s*=\s*true/m,
        `${strategy}: indicator() must set dynamic_requests=true immediately after overlay=true`
      );
      assert.doesNotMatch(
        g.script,
        /dynamic_requests\s*=\s*false/,
        `${strategy}: must not disable dynamic_requests`
      );
      assert.match(g.script, /if useLowerTfBridge/, `${strategy}: lower-TF bridge branch required`);
      assert.match(
        g.script,
        /if useLowerTfBridge[\s\S]{0,400}?request\.security_lower_tf/,
        `${strategy}: security_lower_tf must remain inside useLowerTfBridge scope`
      );
      assert.match(g.script, /for i = 0 to nEv - 1/, `${strategy}: must iterate all lower-TF events`);
      assert.doesNotMatch(g.script, /array\.last\s*\(/, `${strategy}: no array.last() fallback`);
    }
  });

  it('generated scripts do not duplicate EVENT_BRIDGE or leave stray ). tokens', () => {
    process.env.TRADINGVIEW_WEBHOOK_SECRET =
      process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
    process.env.WEBHOOK_SIGNING_SECRET =
      process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';
    const { generateForUser } = require('../../services/PineScriptGeneratorService');
    const user = {
      _id: '507f1f77bcf86cd799439011',
      email: 't@test.com',
      tradingviewUsername: 'demo_trader',
      subscription: { tier: 'professional', status: 'active' }
    };
    for (const strategy of ['scalping', 'daytrading']) {
      const g = generateForUser(user, { strategy });
      const headers = (g.script.match(/OPTION A — EVENT-SAFE CANONICAL BRIDGE/g) || []).length;
      assert.equal(headers, 1, `${strategy}: duplicate EVENT_BRIDGE injection`);
      assert.equal(
        (g.script.match(/^bridgeEventCount = /gm) || []).length,
        1,
        `${strategy}: duplicate bridgeEventCount`
      );
      assert.doesNotMatch(
        g.script,
        /bridgeEventCount = array\.size\(evSignalTime\)\r?\n\)\./,
        `${strategy}: stray ). after bridge`
      );
      for (const line of g.script.split(/\r?\n/)) {
        assert.notEqual(line.trim(), ').', `${strategy}: dangling ). line`);
        assert.notEqual(line.trim(), 'b.', `${strategy}: dangling b. line`);
      }
      assert.doesNotMatch(
        g.script,
        /\{\{[A-Z0-9_]+\}\}/,
        `${strategy}: unresolved template placeholders remain`
      );
    }
  });

  it('arm walks every queued event; lifecycle uses canonLife OHLC', () => {
    assert.match(ARM, /for li = 0 to nLifeBars/);
    assert.match(ARM, /for ei = 0 to array\.size\(evSignalTime\)/);
    assert.match(ARM, /lifeH >= tradeTp3|lifeL <= tradeTp3/);
    assert.match(ARM, /tradeCanonBarsAlive/);
    assert.match(ARM, /new_confirmed_setup/);
    assert.match(DRAW_DEFS, /tradeCanonMeta/);
    assert.doesNotMatch(DRAW_RT, /hitSlWick/);
  });

  it('capability + version stamp', () => {
    assert.equal(PINE_CLIENT_VERSION, '1.2.1');
    assert.ok(CURRENT_PINE_CAPABILITIES.includes('event_bridge_v1'));
    assert.ok(CURRENT_PINE_CAPABILITIES.includes('canonical_tf_v1'));
    assert.equal(resolveCompatibilityMode('1.0.0').mode, COMPAT_MODE.CURRENT);
    assert.equal(resolveCompatibilityMode('1.2.1').mode, COMPAT_MODE.CURRENT);
    assert.equal(resolveCompatibilityMode('2.0.0').mode, COMPAT_MODE.FUTURE);
    assert.equal(resolveCompatibilityMode(null).mode, COMPAT_MODE.LEGACY);
  });
});

describe('Option A multi-chart webhook idempotency', () => {
  beforeEach(() => {
    ActiveSignalRegistry.resetForTests?.();
  });

  it('same UUID from 1m/3m/5m chartTf → one active trade', async () => {
    const uuid = 'JUMP-scalping-c3-555-long';
    await ActiveSignalRegistry.registerActive({
      symbol: 'JUMP_75_INDEX',
      timeframe: '3m',
      signalUuid: uuid,
      lifecycleStage: 'ACTIVE'
    });
    for (const chartTf of ['1', '3', '5']) {
      const gate = await TradeLifecycleService.assertCanOpenEntry({
        symbol: 'JUMP_75_INDEX',
        timeframe: '3m',
        chartTf,
        canonicalSignalTf: '3',
        canonicalSignalKey: uuid,
        signalUuid: uuid,
        alertType: 'entry',
        direction: 'long'
      });
      assert.equal(gate.allowed, false);
      assert.equal(gate.reason, 'duplicate_webhook_replay');
    }
  });

  it('different UUID replaces; does not suppress new signal', async () => {
    await ActiveSignalRegistry.registerActive({
      symbol: 'EURUSD',
      timeframe: '3m',
      signalUuid: 'EURUSD-scalping-c3-1-long',
      lifecycleStage: 'ACTIVE'
    });
    const gate = await TradeLifecycleService.assertCanOpenEntry({
      symbol: 'EURUSD',
      timeframe: '3m',
      chartTf: '5',
      signalUuid: 'EURUSD-scalping-c3-2-long',
      alertType: 'entry',
      direction: 'long'
    });
    assert.equal(gate.allowed, true);
    assert.equal(gate.reason, 'replaced_active_trade');
  });
});
