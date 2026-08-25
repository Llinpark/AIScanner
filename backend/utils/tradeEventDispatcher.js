/**
 * Per-canonical-trade ordered dispatcher.
 *
 * Process-local queue serializes Entry → TP/SL fan-out on THIS Node process
 * after HTTP 202 (optimization only). Cross-machine delivery order is owned by
 * deliverySequencer + tradeEventStore (Redis seq lock + committed HASH, SET NX
 * claims, shared orphan HASH). Mongo Signal is the durable trade.
 *
 * HTTP 202 stays fast: jobs are registered synchronously and run after accept.
 * Telegram / Email / Socket / MT5 never run on the TradingView HTTP path.
 */

const { eventSequenceRank, resolveCanonicalTradeId } = require('./tradeEventIdentity');
const TradeEventStore = require('./tradeEventStore');

const DEFAULT_ORPHAN_WAIT_MS = 2000;

function getOrphanWaitMs() {
  const raw = process.env.ORPHAN_OUTCOME_WAIT_MS;
  if (raw == null || raw === '') return DEFAULT_ORPHAN_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ORPHAN_WAIT_MS;
}

/** @type {Map<string, { jobs: object[], running: boolean, entryQueued: boolean, entryDelivered: boolean, waiters: number, chain: Promise }>} */
const states = new Map();

/** Concurrent Entry accept intents so a slightly-earlier TP/SL can wait without blocking HTTP. */
const entryIntents = new Map();

function getState(key) {
  const id = String(key || '').trim();
  if (!id) return null;
  let s = states.get(id);
  if (!s) {
    s = {
      jobs: [],
      running: false,
      entryQueued: false,
      entryDelivered: false,
      waiters: 0,
      chain: Promise.resolve()
    };
    states.set(id, s);
  }
  return s;
}

function noteEntryIntent(canonicalId) {
  const id = String(canonicalId || '').trim();
  if (!id) return Promise.resolve(null);
  const s = getState(id);
  if (s) s.entryQueued = true;
  if (entryIntents.has(id)) return entryIntents.get(id).promise;
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  entryIntents.set(id, { promise, resolve, at: Date.now() });
  return promise;
}

function resolveEntryIntent(canonicalId, saved) {
  const id = String(canonicalId || '').trim();
  if (!id) return;
  const row = entryIntents.get(id);
  if (row) row.resolve(saved || true);
  const t = setTimeout(() => {
    const cur = entryIntents.get(id);
    if (cur && cur === row) entryIntents.delete(id);
  }, 2000);
  if (typeof t.unref === 'function') t.unref();
}

function clearEntryIntent(canonicalId) {
  const id = String(canonicalId || '').trim();
  if (!id) return;
  const row = entryIntents.get(id);
  if (row) row.resolve(null);
  entryIntents.delete(id);
  const s = states.get(id);
  if (s && !s.jobs.some(j => j.kind === 'entry')) {
    s.entryQueued = false;
  }
}

function getEntryIntent(canonicalId) {
  const id = String(canonicalId || '').trim();
  return id ? entryIntents.get(id) || null : null;
}

function jobSort(a, b) {
  const ra = eventSequenceRank(a.alertType) - eventSequenceRank(b.alertType);
  if (ra !== 0) return ra;
  const ta = Number(a.eventTimestamp || 0);
  const tb = Number(b.eventTimestamp || 0);
  if (ta !== tb) return ta - tb;
  return Number(a.bridgeEventIndex || 0) - Number(b.bridgeEventIndex || 0);
}

function pickJob(s) {
  if (!s.jobs.length) return null;
  const entryIdx = s.jobs.findIndex(j => j.kind === 'entry' || eventSequenceRank(j.alertType) === 0);
  if (entryIdx >= 0 && !s.entryDelivered) {
    return s.jobs.splice(entryIdx, 1)[0];
  }
  // Never deliver TP/SL before the Entry job for this canonical trade.
  if (!s.entryDelivered) return null;
  s.jobs.sort(jobSort);
  return s.jobs.shift();
}

async function pump(key) {
  const s = states.get(key);
  if (!s || s.running) return;
  s.running = true;
  try {
    while (true) {
      const job = pickJob(s);
      if (!job) break;
      try {
        await job.run();
      } catch (err) {
        console.error(
          `[TradeEventDispatcher] job failed key=${key} kind=${job.kind || job.alertType}:`,
          err?.message || err
        );
      }
      if (job.kind === 'entry' || eventSequenceRank(job.alertType) === 0) {
        s.entryDelivered = true;
      }
    }
  } finally {
    s.running = false;
    const hasEntryJob = s.jobs.some(j => j.kind === 'entry' || eventSequenceRank(j.alertType) === 0);
    if (s.jobs.length && (s.entryDelivered || hasEntryJob)) {
      setImmediate(() => pump(key));
    }
  }
}

/**
 * Register a fan-out job. Returns immediately (does not run Telegram on the caller).
 */
function enqueue(canonicalId, job) {
  const id = String(canonicalId || '').trim();
  if (!id || !job || typeof job.run !== 'function') return Promise.resolve();
  const s = getState(id);
  const item = {
    kind: job.kind || (eventSequenceRank(job.alertType) === 0 ? 'entry' : 'outcome'),
    alertType: job.alertType || 'entry',
    eventTimestamp: job.eventTimestamp || 0,
    bridgeEventIndex: job.bridgeEventIndex || 0,
    run: job.run
  };
  if (item.kind === 'entry') s.entryQueued = true;
  if (job.entryAlreadyDurable && !s.entryQueued && item.kind !== 'entry') {
    s.entryDelivered = true;
  }
  s.jobs.push(item);
  setImmediate(() => pump(id));
  return s.chain;
}

async function waitForIdle(canonicalId, timeoutMs = 8000) {
  const id = String(canonicalId || '').trim();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = states.get(id);
    if (!s || (!s.running && s.jobs.length === 0 && s.waiters === 0)) return;
    await new Promise(r => setImmediate(r));
  }
}

function beginWaiter(canonicalId) {
  const s = getState(canonicalId);
  if (s) s.waiters += 1;
}

function endWaiter(canonicalId) {
  const s = states.get(canonicalId);
  if (!s) return;
  s.waiters = Math.max(0, s.waiters - 1);
}

/**
 * Wait (async, not on HTTP) for a durable Entry of this canonical id.
 * Checks process-local intent, shared Redis entry flag, then findEntryFn (Mongo/memory).
 */
async function waitForEntry(canonicalId, findEntryFn, timeoutMs) {
  const id = String(canonicalId || '').trim();
  const waitMs = timeoutMs != null ? timeoutMs : getOrphanWaitMs();
  beginWaiter(id);
  try {
    const deadline = Date.now() + waitMs;
    while (Date.now() <= deadline) {
      const found = await findEntryFn(id);
      if (found) return found;
      if (await TradeEventStore.isEntryReady(id)) {
        const afterReady = await findEntryFn(id);
        if (afterReady) return afterReady;
      }
      const intent = getEntryIntent(id);
      if (intent) {
        const remaining = Math.max(0, deadline - Date.now());
        await Promise.race([
          intent.promise,
          new Promise(r => setTimeout(r, Math.min(50, remaining || 0)))
        ]);
        const after = await findEntryFn(id);
        if (after) return after;
      } else {
        await new Promise(r => setTimeout(r, 25));
      }
    }
    if (await TradeEventStore.isEntryReady(id)) {
      const late = await findEntryFn(id);
      if (late) return late;
    }
    return (await findEntryFn(id)) || null;
  } finally {
    endWaiter(id);
  }
}

function resetLocalQueuesForTests() {
  states.clear();
  entryIntents.clear();
  acceptLocks.clear();
}

function resetForTests() {
  resetLocalQueuesForTests();
  TradeEventStore.resetForTests();
}

const acceptLocks = new Map();

function lockBusyError() {
  const err = new Error('canonical_lock_busy');
  err.code = 'CANONICAL_LOCK_BUSY';
  return err;
}

/**
 * Serialize durable accept for one canonical id across Fly machines (Redis).
 * Process-local promise chain is tests / explicit memory fallback only.
 * Production Redis down or lock timeout must NOT independently persist/fan-out.
 */
async function withCanonicalLock(canonicalId, fn) {
  const id = String(canonicalId || '').trim() || '_none';
  let acquired = await TradeEventStore.acquireLock(id);
  if (!acquired.ok && acquired.backend === 'redis') {
    acquired = await TradeEventStore.acquireLock(id);
  }
  if (acquired.ok) {
    try {
      return await fn();
    } finally {
      await TradeEventStore.releaseLock(id, acquired.token);
    }
  }

  if (acquired.reason === 'redis_unavailable' || acquired.backend === 'none') {
    const err = new Error('redis_unavailable');
    err.code = TradeEventStore.REDIS_UNAVAILABLE || 'REDIS_UNAVAILABLE';
    err.reason = 'redis_unavailable';
    throw err;
  }

  if (acquired.backend === 'redis') {
    throw lockBusyError();
  }

  const prev = acceptLocks.get(id) || Promise.resolve();
  const curr = prev.then(fn, fn);
  acceptLocks.set(
    id,
    curr.then(
      () => undefined,
      () => undefined
    )
  );
  try {
    return await curr;
  } finally {
    if (acquired.ok) await TradeEventStore.releaseLock(id, acquired.token);
  }
}

function canonicalIdFromAccept(acceptResult) {
  return resolveCanonicalTradeId(acceptResult?.signalData || acceptResult?.saved || acceptResult || {});
}

module.exports = {
  DEFAULT_ORPHAN_WAIT_MS,
  getOrphanWaitMs,
  noteEntryIntent,
  resolveEntryIntent,
  clearEntryIntent,
  getEntryIntent,
  enqueue,
  waitForIdle,
  waitForEntry,
  beginWaiter,
  endWaiter,
  withCanonicalLock,
  resetLocalQueuesForTests,
  resetForTests,
  canonicalIdFromAccept
};
