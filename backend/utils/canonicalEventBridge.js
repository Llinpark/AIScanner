/**
 * Option A — event-safe canonical projection + lifecycle rules (JS twin of Pine bridge).
 *
 * Pine cannot be executed in unit tests; this module encodes the same contracts so
 * behavioural tests can prove no higher-TF collapse and canonical outcome authority.
 */

'use strict';

/**
 * @param {string} ticker
 * @param {string} strategyKey
 * @param {string} canonicalTfPine  e.g. "3" or "5"
 * @param {number} signalTime
 * @param {'long'|'short'} direction
 */
function makeCanonicalSignalId(ticker, strategyKey, canonicalTfPine, signalTime, direction) {
  return `${ticker}-${strategyKey}-c${canonicalTfPine}-${signalTime}-${direction}`;
}

/**
 * Events whose signalTime falls inside [barOpen, barOpen + displayTfMs).
 * Higher display TF must return ALL events — never only the last.
 *
 * @param {Array<{ signalTime: number, direction: string, entry: number, sl: number, tp1: number, tp2: number, tp3: number }>} events
 * @param {number} displayBarOpenMs
 * @param {number} displayTfMs
 */
function eventsInDisplayBar(events, displayBarOpenMs, displayTfMs) {
  const end = displayBarOpenMs + displayTfMs;
  return (events || [])
    .filter((e) => {
      const t = Number(e.signalTime);
      return Number.isFinite(t) && t >= displayBarOpenMs && t < end;
    })
    .sort(
      (a, b) =>
        Number(a.signalTime) - Number(b.signalTime) ||
        String(a.direction).localeCompare(String(b.direction))
    );
}

/**
 * Simulate request.security last-value collapse (the bug) vs event-safe bridge.
 * @returns {{ collapsed: object|null, eventSafe: object[] }}
 */
function projectToHigherDisplay(events, displayBarOpenMs, displayTfMs) {
  const inBar = eventsInDisplayBar(events, displayBarOpenMs, displayTfMs);
  const collapsed = inBar.length ? inBar[inBar.length - 1] : null;
  return { collapsed, eventSafe: inBar };
}

/**
 * Same-bar SL + TP3 tie-break: resolve by close (matches Pine drawing engine).
 * @param {'long'|'short'} direction
 * @param {{ high: number, low: number, close: number }} bar
 * @param {{ sl: number, tp1: number, tp2: number, tp3: number }} levels
 */
function evaluateCanonBarOutcome(direction, bar, levels) {
  const longTrade = direction === 'long';
  const hitSlWick = longTrade ? bar.low <= levels.sl : bar.high >= levels.sl;
  const hitTp3Wick = longTrade ? bar.high >= levels.tp3 : bar.low <= levels.tp3;
  const hitTp2 = longTrade ? bar.high >= levels.tp2 : bar.low <= levels.tp2;
  const hitTp1 = longTrade ? bar.high >= levels.tp1 : bar.low <= levels.tp1;
  const hitSl =
    hitSlWick && hitTp3Wick
      ? longTrade
        ? bar.close <= levels.sl
        : bar.close >= levels.sl
      : hitSlWick;
  const hitTp3 =
    hitSlWick && hitTp3Wick
      ? longTrade
        ? bar.close >= levels.tp3
        : bar.close <= levels.tp3
      : hitTp3Wick;

  let terminal = null;
  if (hitSl) terminal = 'stop_loss';
  else if (hitTp3) terminal = 'take_profit_3';

  return {
    hitSl,
    hitTp3,
    hitTp1: Boolean(hitTp1),
    hitTp2: Boolean(hitTp2),
    terminal
  };
}

/**
 * Walk canonical bars after entry; expiryCounts canonical bars (not display bars).
 */
function runCanonicalLifecycle({
  direction,
  levels,
  canonBars,
  entrySignalTime,
  expiryBars,
  enableTradeExpiry = true
}) {
  let canonBarsAlive = 0;
  let tp1 = false;
  let tp2 = false;
  const milestones = [];

  for (const bar of canonBars) {
    if (Number(bar.time) < Number(entrySignalTime)) continue;
    canonBarsAlive += 1;
    const ev = evaluateCanonBarOutcome(direction, bar, levels);
    if (ev.hitTp1 && !tp1) {
      tp1 = true;
      milestones.push({ type: 'take_profit_1', time: bar.time });
    }
    if (ev.hitTp2 && !tp2) {
      tp2 = true;
      milestones.push({ type: 'take_profit_2', time: bar.time });
    }
    if (ev.terminal) {
      return {
        closed: true,
        reason: ev.terminal,
        canonBarsAlive,
        milestones,
        outcomeBarTime: bar.time
      };
    }
    if (enableTradeExpiry && canonBarsAlive >= expiryBars) {
      return {
        closed: true,
        reason: 'expired',
        canonBarsAlive,
        milestones,
        outcomeBarTime: bar.time
      };
    }
  }
  return { closed: false, reason: null, canonBarsAlive, milestones, outcomeBarTime: null };
}

/** TF label → ms (Pine/TV periods used in Option A). */
function tfToMs(tf) {
  const map = {
    '1': 60_000,
    '1m': 60_000,
    '3': 180_000,
    '3m': 180_000,
    '5': 300_000,
    '5m': 300_000,
    '15': 900_000,
    '15m': 900_000
  };
  return map[String(tf)] || null;
}

/**
 * Expiry duration must use canonical TF ms × expiryBars (backend computeExpiresAt contract).
 */
function expiryDurationMs(canonicalTf, expiryBars) {
  const ms = tfToMs(canonicalTf);
  if (ms == null || !Number.isFinite(expiryBars)) return null;
  return ms * Math.floor(expiryBars);
}

module.exports = {
  makeCanonicalSignalId,
  eventsInDisplayBar,
  projectToHigherDisplay,
  evaluateCanonBarOutcome,
  runCanonicalLifecycle,
  tfToMs,
  expiryDurationMs
};
