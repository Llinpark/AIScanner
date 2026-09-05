/**
 * Pure helpers for MT5 EA trade management (partials, presets, report events).
 * Mirrored conceptually in KachingTradeCopier.mq5 — keep in sync when changing rules.
 */

const PARTIAL_PRESETS = {
  conservative: { tp1: 25, tp2: 25, tp3: 50 },
  balanced: { tp1: 40, tp2: 30, tp3: 30 },
  aggressive: { tp1: 50, tp2: 30, tp3: 20 }
};

/** Default commercial preset: Balanced 40/30/30 */
const DEFAULT_PARTIAL_PERCENTS = { ...PARTIAL_PRESETS.balanced };

const MANAGEMENT_EVENTS = [
  'opened',
  'tp1_hit',
  'tp2_hit',
  'tp3_hit',
  'break_even',
  'trailing',
  'partial_close',
  'sl_hit',
  'closed',
  'filled',
  'failed',
  'sent'
];

/** Alias bases for EA-side / backend documentation (suffix handled separately). */
const SYMBOL_ALIASES = {
  EURUSD: ['EURUSD', 'EURUSDm', 'EURUSD.m', 'EURUSD.i', 'EURUSDpro'],
  XAUUSD: ['XAUUSD', 'GOLD', 'XAUUSDm', 'XAUUSD.m', 'GOLD.m', 'XAUUSD.'],
  XAGUSD: ['XAGUSD', 'SILVER', 'XAGUSDm', 'XAGUSD.m'],
  US30: ['US30', 'DJ30', 'DJIA', 'US30.cash', 'US30m', 'WallStreet30'],
  US100: ['US100', 'NAS100', 'USTEC', 'NAS100.cash', 'US100m'],
  BTCUSD: ['BTCUSD', 'BTCUSDT', 'BTCUSD.m'],
  GBPUSD: ['GBPUSD', 'GBPUSDm', 'GBPUSD.m'],
  USDJPY: ['USDJPY', 'USDJPYm', 'USDJPY.m']
};

function roundPercent(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Validate TP close percents. Must each be >= 0 and sum to 100 (±0.01).
 * @returns {{ ok: boolean, sum: number, reason?: string, normalized?: {tp1,tp2,tp3} }}
 */
function validatePartialPercents(tp1, tp2, tp3) {
  const a = Number(tp1);
  const b = Number(tp2);
  const c = Number(tp3);
  if (![a, b, c].every(v => Number.isFinite(v) && v >= 0)) {
    return { ok: false, sum: NaN, reason: 'non_finite_or_negative' };
  }
  const sum = roundPercent(a + b + c);
  if (Math.abs(sum - 100) > 0.01) {
    return { ok: false, sum, reason: 'sum_not_100' };
  }
  return {
    ok: true,
    sum,
    normalized: { tp1: roundPercent(a), tp2: roundPercent(b), tp3: roundPercent(c) }
  };
}

function resolvePartialPreset(name) {
  const key = String(name || '')
    .trim()
    .toLowerCase();
  if (PARTIAL_PRESETS[key]) {
    return { name: key, ...PARTIAL_PRESETS[key] };
  }
  return { name: 'balanced', ...PARTIAL_PRESETS.balanced };
}

/**
 * Volume to close at a TP given initial lot and percent (broker volume step applied by EA).
 */
function partialCloseVolume(initialVolume, percent, remainingVolume) {
  const init = Number(initialVolume);
  const pct = Number(percent);
  const rem = Number(remainingVolume);
  if (!(init > 0) || !(pct > 0) || !(rem > 0)) return 0;
  const raw = (init * pct) / 100;
  return Math.min(rem, Math.max(0, Number(raw.toFixed(8))));
}

function normalizeManagementEvent(raw) {
  const event = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (event === 'open' || event === 'fill') return 'opened';
  if (event === 'be' || event === 'breakeven') return 'break_even';
  if (event === 'trail' || event === 'trailing_stop') return 'trailing';
  if (event === 'tp1' || event === 'take_profit_1') return 'tp1_hit';
  if (event === 'tp2' || event === 'take_profit_2') return 'tp2_hit';
  if (event === 'tp3' || event === 'take_profit_3') return 'tp3_hit';
  if (event === 'stop_loss' || event === 'sl') return 'sl_hit';
  if (MANAGEMENT_EVENTS.includes(event)) return event;
  return null;
}

/**
 * Map a report event onto execution status + managementState patch (additive, backward compatible).
 */
function applyManagementEvent(existing = {}, payload = {}) {
  const event =
    normalizeManagementEvent(payload.event) ||
    normalizeManagementEvent(payload.status) ||
    null;

  const prev = existing.managementState && typeof existing.managementState === 'object'
    ? { ...existing.managementState }
    : {
        phase: 'queued',
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        breakEvenApplied: false,
        trailingActive: false,
        remainingVolume: existing.lotSize != null ? Number(existing.lotSize) : null,
        closedVolume: 0,
        partialClosePercent: 0,
        lastEvent: null,
        lastEventAt: null,
        events: [],
        ackedEventUuids: []
      };

  const events = Array.isArray(prev.events) ? [...prev.events] : [];
  const now = payload.at ? new Date(payload.at) : new Date();
  const remainingVolume =
    payload.remainingVolume != null
      ? Number(payload.remainingVolume)
      : prev.remainingVolume;
  const closedVolume =
    payload.closedVolume != null
      ? Number(payload.closedVolume)
      : payload.partialVolume != null
        ? Number(prev.closedVolume || 0) + Number(payload.partialVolume)
        : prev.closedVolume;
  const partialClosePercent =
    payload.partialClosePercent != null
      ? Number(payload.partialClosePercent)
      : prev.partialClosePercent;

  let status = existing.status;
  let phase = prev.phase || 'queued';

  if (event === 'opened' || event === 'filled') {
    status = 'filled';
    phase = 'open';
  } else if (event === 'failed' || payload.status === 'failed') {
    status = 'failed';
    phase = 'failed';
  } else if (event === 'sent' || payload.status === 'sent') {
    status = 'sent';
    phase = 'sent';
  } else if (event === 'tp1_hit') {
    status = 'filled';
    phase = 'tp1';
    prev.tp1Hit = true;
  } else if (event === 'tp2_hit') {
    status = 'filled';
    phase = 'tp2';
    prev.tp2Hit = true;
  } else if (event === 'tp3_hit') {
    status = 'filled';
    phase = 'tp3';
    prev.tp3Hit = true;
  } else if (event === 'break_even') {
    status = status === 'pending' || status === 'sent' ? 'filled' : status;
    phase = 'break_even';
    prev.breakEvenApplied = true;
  } else if (event === 'trailing' || event === 'partial_close') {
    status = status === 'pending' || status === 'sent' ? 'filled' : status;
    if (event === 'trailing') {
      phase = 'trailing';
      prev.trailingActive = true;
    } else {
      phase = phase === 'queued' ? 'open' : phase;
    }
  } else if (event === 'sl_hit') {
    status = 'closed';
    phase = 'sl_hit';
  } else if (event === 'closed') {
    status = 'closed';
    phase = 'closed';
  } else if (payload.status && ['filled', 'failed', 'sent', 'closed', 'cancelled'].includes(payload.status)) {
    status = payload.status;
    if (payload.status === 'filled') phase = phase === 'queued' || phase === 'sent' ? 'open' : phase;
    if (payload.status === 'closed') phase = 'closed';
    if (payload.status === 'failed') phase = 'failed';
  }

  const eventUuid =
    payload.eventUuid != null && String(payload.eventUuid).trim()
      ? String(payload.eventUuid).trim()
      : payload.eventId != null && String(payload.eventId).trim()
        ? String(payload.eventId).trim()
        : null;

  if (event) {
    events.push({
      type: event,
      at: now,
      price: payload.price != null ? Number(payload.price) : payload.fillPrice != null ? Number(payload.fillPrice) : undefined,
      volume: payload.partialVolume != null ? Number(payload.partialVolume) : undefined,
      remainingVolume: remainingVolume != null ? Number(remainingVolume) : undefined,
      note: payload.note || payload.error || undefined,
      eventUuid: eventUuid || undefined
    });
    // Cap history to keep documents bounded
    if (events.length > 50) events.splice(0, events.length - 50);
  }

  let ackedEventUuids = Array.isArray(prev.ackedEventUuids) ? [...prev.ackedEventUuids] : [];
  if (eventUuid) {
    if (!ackedEventUuids.includes(eventUuid)) ackedEventUuids.push(eventUuid);
    if (ackedEventUuids.length > 100) ackedEventUuids = ackedEventUuids.slice(-100);
  }

  const managementState = {
    ...prev,
    phase,
    remainingVolume: remainingVolume != null ? Number(remainingVolume) : prev.remainingVolume,
    closedVolume: closedVolume != null ? Number(closedVolume) : prev.closedVolume,
    partialClosePercent: partialClosePercent != null ? Number(partialClosePercent) : prev.partialClosePercent,
    lastEvent: event || prev.lastEvent,
    lastEventAt: event ? now : prev.lastEventAt,
    events,
    ackedEventUuids
  };

  return { status, managementState, event, eventUuid, duplicate: false };
}

/**
 * Compact base symbol for matching (EURUSD, XAUUSD, US30…).
 */
function compactSymbolBase(symbol) {
  return String(symbol || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^(SPOT|CASH)/, '')
    .replace(/(CASH|SPOT|PRO|RAW|ECN|M|\.I|\.M)$/g, '');
}

/**
 * Suggest alias candidates for a catalog / TV symbol (no broker enumeration).
 */
function suggestSymbolCandidates(symbol) {
  const compact = compactSymbolBase(symbol);
  if (!compact) return [];
  const out = new Set([compact]);

  for (const [base, aliases] of Object.entries(SYMBOL_ALIASES)) {
    const baseCompact = compactSymbolBase(base);
    if (
      compact === baseCompact ||
      aliases.some(a => compactSymbolBase(a) === compact) ||
      compact.includes(baseCompact) ||
      baseCompact.includes(compact)
    ) {
      aliases.forEach(a => out.add(a));
      out.add(base);
    }
  }

  // Gold / Dow common swaps
  if (compact.includes('GOLD') || compact === 'XAUUSD') {
    SYMBOL_ALIASES.XAUUSD.forEach(a => out.add(a));
  }
  if (compact.includes('DJ30') || compact.includes('DJIA') || compact === 'US30') {
    SYMBOL_ALIASES.US30.forEach(a => out.add(a));
  }

  return [...out];
}

function formatManagementLabel(state) {
  if (!state || !state.phase) return '';
  const map = {
    queued: 'Queued',
    sent: 'Claimed',
    open: 'Open',
    tp1: 'TP1 hit',
    tp2: 'TP2 hit',
    tp3: 'TP3 hit',
    break_even: 'Break-even',
    trailing: 'Trailing',
    sl_hit: 'SL hit',
    closed: 'Closed',
    failed: 'Failed'
  };
  return map[state.phase] || state.phase;
}

module.exports = {
  PARTIAL_PRESETS,
  DEFAULT_PARTIAL_PERCENTS,
  MANAGEMENT_EVENTS,
  SYMBOL_ALIASES,
  validatePartialPercents,
  resolvePartialPreset,
  partialCloseVolume,
  normalizeManagementEvent,
  applyManagementEvent,
  compactSymbolBase,
  suggestSymbolCandidates,
  formatManagementLabel
};
