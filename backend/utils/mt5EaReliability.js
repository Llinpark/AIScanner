/**
 * Pure mirrors of KachingTradeCopier.mq5 v1.22+ reliability rules.
 * Used by automated tests — keep in sync with EA transactional / idempotent semantics.
 */

/** Partial / BE / trail retry backoff (seconds): 2 → 5 → 10 → 20 → 60 (cap). */
const RETRY_BACKOFF_SECONDS = [2, 5, 10, 20, 60];

function nextRetryDelaySeconds(retryCount) {
  const idx = Math.max(0, Math.min(RETRY_BACKOFF_SECONDS.length - 1, Number(retryCount) || 0));
  return RETRY_BACKOFF_SECONDS[idx];
}

function tradeRetcodeOk(retcode) {
  const code = Number(retcode);
  // MQL5 TRADE_RETCODE_DONE=10009, DONE_PARTIAL=10010, PLACED=10008
  return code === 10009 || code === 10010 || code === 10008;
}

/**
 * Transaction order for managed flags:
 * attempt → broker success → flags → persist → report → chart.
 * Never mark TP/BE/trail complete before broker confirms.
 */
function applyBrokerOpResult(state, op, brokerOk) {
  const next = {
    ...state,
    tp1Hit: !!state.tp1Hit,
    tp2Hit: !!state.tp2Hit,
    tp3Hit: !!state.tp3Hit,
    breakEvenDone: !!state.breakEvenDone,
    trailReported: !!state.trailReported,
    pendingOp: state.pendingOp || '',
    retryCount: Number(state.retryCount) || 0,
    dirty: false
  };

  if (!brokerOk) {
    next.pendingOp = op;
    next.retryCount = next.retryCount + 1;
    next.nextRetryDelaySec = nextRetryDelaySeconds(next.retryCount - 1);
    return next;
  }

  if (op === 'tp1') next.tp1Hit = true;
  else if (op === 'tp2') next.tp2Hit = true;
  else if (op === 'tp3') next.tp3Hit = true;
  else if (op === 'be') next.breakEvenDone = true;
  else if (op === 'trail') next.trailReported = true;

  next.pendingOp = '';
  next.retryCount = 0;
  next.nextRetryDelaySec = 0;
  next.dirty = true;
  return next;
}

/** Price still beyond TP so a rejected partial should keep retrying. */
function shouldRetryPartial(isBuy, price, tpLevel) {
  const p = Number(price);
  const tp = Number(tpLevel);
  if (!(tp > 0) || !Number.isFinite(p)) return false;
  return isBuy ? p >= tp : p <= tp;
}

/**
 * Durable event queue semantics (EA Common Files KachingAI_event_queue.dat):
 * persist → POST → remove only on HTTP 200 + acknowledged=true.
 */
function eventQueueAfterPost(queue, eventUuid, httpStatus, acknowledged) {
  const list = Array.isArray(queue) ? [...queue] : [];
  const ok = httpStatus === 200 && acknowledged === true;
  if (!ok) return { queue: list, removed: false };
  const next = list.filter(e => e && e.eventUuid !== eventUuid);
  return { queue: next, removed: next.length !== list.length };
}

/** Backend dedupe: skip apply when eventUuid already acknowledged. */
function shouldApplyReportEvent(ackedUuids, eventUuid) {
  if (!eventUuid) return true; // legacy reports without UUID still apply
  const set = Array.isArray(ackedUuids) ? ackedUuids : [];
  return !set.includes(String(eventUuid));
}

function rememberAckedEventUuid(ackedUuids, eventUuid, cap = 100) {
  if (!eventUuid) return Array.isArray(ackedUuids) ? [...ackedUuids] : [];
  const set = Array.isArray(ackedUuids) ? [...ackedUuids] : [];
  const id = String(eventUuid);
  if (!set.includes(id)) set.push(id);
  if (set.length > cap) set.splice(0, set.length - cap);
  return set;
}

/**
 * Heartbeat-aware reclaim: after 120s sent-without-ticket,
 * reclaim only when claimer heartbeat is missing (or no devices online for legacy).
 */
function shouldReclaimSentClaim({
  status,
  mt5Ticket,
  claimedAt,
  createdAt,
  claimedByDeviceId,
  devices,
  nowMs = Date.now(),
  reclaimMs = 120000,
  heartbeatOfflineMs = 90000
}) {
  if (status !== 'sent') return false;
  if (mt5Ticket) return false;
  const claimedMs = new Date(claimedAt || createdAt || 0).getTime();
  if (!claimedMs || nowMs - claimedMs < reclaimMs) return false;

  const active = (devices || []).filter(d => d && !d.revokedAt);
  const isAlive = d => {
    const lastHb = d.lastHeartbeatAt ? new Date(d.lastHeartbeatAt).getTime() : 0;
    return lastHb > 0 && nowMs - lastHb <= heartbeatOfflineMs;
  };

  if (claimedByDeviceId) {
    const claimer = active.find(d => String(d.deviceId) === String(claimedByDeviceId));
    if (claimer && isAlive(claimer)) return false; // healthy slow EA — wait
    return true; // claimer missing/offline — reclaim
  }

  // Legacy claims without claimer id: any live heartbeat protects
  if (active.some(isAlive)) return false;
  return true;
}

/**
 * --- Idempotent broker ops (v1.22) — Expected vs Broker ---
 */

function volumeEps(step = 0.01) {
  const s = Number(step);
  const v = Number.isFinite(s) && s > 0 ? s : 0.01;
  return Math.max(v * 0.51, 1e-8);
}

function priceEps(point = 0.00001) {
  const p = Number(point);
  return Number.isFinite(p) && p > 0 ? p : 0.00001;
}

function slEqualOrBetter(isBuy, brokerSl, desiredSl, tol = 1e-8) {
  const b = Number(brokerSl);
  const d = Number(desiredSl);
  const t = Number(tol) || 0;
  if (!(d > 0) || !(b > 0)) return false;
  return isBuy ? b + t >= d : b - t <= d;
}

/** Expected remaining volume after TP level (1/2/3) using close percents. */
function expectedRemainingAfterTpLevel(
  { initialVolume, tp1Pct = 40, tp2Pct = 30 },
  level
) {
  const init = Number(initialVolume) || 0;
  if (level >= 3) return 0;
  let pctClosed = 0;
  if (level >= 1) pctClosed += Number(tp1Pct) || 0;
  if (level >= 2) pctClosed += Number(tp2Pct) || 0;
  if (pctClosed >= 100) return 0;
  return init * (100 - pctClosed) / 100;
}

/**
 * Partial already done on broker? (live volume / history / closedFrac)
 * Mirrors EA ValidatePartialAlreadyDone.
 */
function validatePartialAlreadyDone({
  initialVolume,
  liveVolume,
  level,
  tp1Pct = 40,
  tp2Pct = 30,
  volumeStep = 0.01,
  historyClosedVolume = null
}) {
  const init = Number(initialVolume) || 0;
  const live = Number(liveVolume);
  if (!(init > 0) || !Number.isFinite(live)) return false;
  const eps = volumeEps(volumeStep);
  const expected = expectedRemainingAfterTpLevel({ initialVolume: init, tp1Pct, tp2Pct }, level);
  if (level >= 3) return live <= eps;
  if (live <= expected + eps) return true;

  if (historyClosedVolume != null && Number.isFinite(Number(historyClosedVolume))) {
    const needClosed = init - expected;
    if (Number(historyClosedVolume) + eps >= needClosed) return true;
  }

  const closedFrac = (init - live) / init;
  if (level === 1 && closedFrac >= 0.15) return true;
  if (level === 2 && closedFrac >= 0.45) return true;
  return false;
}

function validateBeAlreadyDone({ isBuy, brokerSl, desiredBeSl, point = 0.00001 }) {
  return slEqualOrBetter(!!isBuy, brokerSl, desiredBeSl, priceEps(point));
}

function validateTrailAlreadyDone({ isBuy, brokerSl, desiredTrailSl, point = 0.00001 }) {
  return slEqualOrBetter(!!isBuy, brokerSl, desiredTrailSl, priceEps(point));
}

/**
 * Safe retry decision: validate first → sync | execute.
 * @returns {{ action: 'sync'|'execute', reason: string }}
 */
function decideBrokerOp(alreadyDone, detail = '') {
  if (alreadyDone) {
    return { action: 'sync', reason: detail || 'already_done' };
  }
  return { action: 'execute', reason: detail || 'need_broker_op' };
}

/**
 * Recovery validation: repair TP/BE/trail flags from live position (+ optional history).
 * Never file-only — caller must supply broker position.
 */
function reconcileManagedFlags(managed, position, history = null) {
  if (!managed || !position) return { ...managed, repaired: false };
  const next = {
    ...managed,
    repaired: false,
    repairs: []
  };
  const initVol = Number(managed.initialVolume) || 0;
  const rem = Number(position.volume);
  const entry = Number(managed.entry);
  const sl = Number(position.sl);
  const isBuy = !!managed.isBuy;
  const tp1Pct = Number(managed.tp1Pct != null ? managed.tp1Pct : 40);
  const tp2Pct = Number(managed.tp2Pct != null ? managed.tp2Pct : 30);
  const step = Number(managed.volumeStep != null ? managed.volumeStep : 0.01);
  const eps = volumeEps(step);
  const histClosed =
    history && Number.isFinite(Number(history.closedVolume))
      ? Number(history.closedVolume)
      : null;

  if (Number.isFinite(rem) && initVol > 0) {
    next.remainingVolume = rem;
    const closedFromLive = initVol - rem;
    const closedVol =
      histClosed != null ? Math.max(histClosed, closedFromLive) : closedFromLive;
    const closedFrac = closedVol / initVol;
    const exp1 = expectedRemainingAfterTpLevel(
      { initialVolume: initVol, tp1Pct, tp2Pct },
      1
    );
    const exp2 = expectedRemainingAfterTpLevel(
      { initialVolume: initVol, tp1Pct, tp2Pct },
      2
    );

    if (!next.tp1Hit && (rem <= exp1 + eps || closedFrac >= 0.15)) {
      next.tp1Hit = true;
      next.repaired = true;
      next.repairs.push('tp1');
    }
    if (!next.tp2Hit && (rem <= exp2 + eps || closedFrac >= 0.45)) {
      next.tp2Hit = true;
      next.repaired = true;
      next.repairs.push('tp2');
    }
    if (rem <= eps && !next.tp3Hit) {
      next.tp3Hit = true;
      next.repaired = true;
      next.repairs.push('tp3');
    }
    // Flags claim TP complete but volume untouched → clear (failed close marked early)
    if (next.tp1Hit && Math.abs(rem - initVol) < eps && closedFrac < 0.01) {
      next.tp1Hit = false;
      next.tp2Hit = false;
      next.tp3Hit = false;
      next.repaired = true;
      next.repairs.push('clear_tp');
    }
  }

  if (Number.isFinite(sl) && Number.isFinite(entry) && entry > 0) {
    const beOffset = Number(managed.beOffsetPrice) || 0;
    const desiredBe = isBuy ? entry + beOffset : entry - beOffset;
    const atOrBeyondBe =
      slEqualOrBetter(isBuy, sl, desiredBe, priceEps(managed.point)) ||
      (isBuy ? sl >= entry : sl > 0 && sl <= entry);
    if (atOrBeyondBe && !next.breakEvenDone) {
      next.breakEvenDone = true;
      next.repaired = true;
      next.repairs.push('be');
    }
    // BE flagged but SL still at initial protective stop far from entry
    if (next.breakEvenDone && Number.isFinite(managed.initialSl)) {
      const initSl = Number(managed.initialSl);
      const nearInit =
        Math.abs(sl - initSl) < Math.abs(entry - initSl) * 0.25 &&
        (isBuy ? sl < entry : sl > entry);
      if (nearInit) {
        next.breakEvenDone = false;
        next.repaired = true;
        next.repairs.push('clear_be');
      }
    }

    // Trail already beyond entry while armed → sync trailReported
    if (
      next.trailArmed &&
      next.breakEvenDone &&
      !next.trailReported &&
      (isBuy ? sl > entry : sl > 0 && sl < entry)
    ) {
      next.trailReported = true;
      next.repaired = true;
      next.repairs.push('trail');
    }
  }

  // Clear pending ops satisfied by broker
  const pop = next.pendingOp || '';
  if (
    (pop === 'tp1' && next.tp1Hit) ||
    (pop === 'tp2' && next.tp2Hit) ||
    (pop === 'tp3' && next.tp3Hit) ||
    (pop === 'be' && next.breakEvenDone)
  ) {
    next.pendingOp = '';
    next.retryCount = 0;
    next.repaired = true;
    next.repairs.push('clear_pending');
  }

  return next;
}

/** Persist only when managed state actually changes. */
function shouldPersistManaged(prevSnapshot, nextSnapshot) {
  return JSON.stringify(prevSnapshot) !== JSON.stringify(nextSnapshot);
}

/** Reconcile interval mirror (seconds) — EA RECONCILE_SECONDS. */
const RECONCILE_SECONDS = 60;

function shouldRunReconcile(lastReconcileAtMs, nowMs = Date.now(), force = false) {
  if (force) return true;
  if (!lastReconcileAtMs) return true;
  return nowMs - lastReconcileAtMs >= RECONCILE_SECONDS * 1000;
}

module.exports = {
  RETRY_BACKOFF_SECONDS,
  RECONCILE_SECONDS,
  nextRetryDelaySeconds,
  tradeRetcodeOk,
  applyBrokerOpResult,
  shouldRetryPartial,
  eventQueueAfterPost,
  shouldApplyReportEvent,
  rememberAckedEventUuid,
  shouldReclaimSentClaim,
  reconcileManagedFlags,
  shouldPersistManaged,
  volumeEps,
  priceEps,
  slEqualOrBetter,
  expectedRemainingAfterTpLevel,
  validatePartialAlreadyDone,
  validateBeAlreadyDone,
  validateTrailAlreadyDone,
  decideBrokerOp,
  shouldRunReconcile
};
