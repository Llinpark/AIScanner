/**
 * Production SL risk hierarchy for Kaching Sweep+FVG.
 *
 * Rules:
 * - Never clamp a structural stop closer to entry without a real candidate.
 * - Cap by entry-TF ATR × maxStopAtrMult.
 * - Prefer valid FVG/local stop on synthetics when sweep is too far.
 * - Reject when no candidate is within the max distance.
 */

'use strict';

function isSyntheticSymbol(symbol) {
  const s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
  return (
    s.includes('JUMP') ||
    s.includes('BOOM') ||
    s.includes('CRASH') ||
    s.includes('VOLATILITY') ||
    s.includes('STEPINDEX') ||
    s.includes('RANGEBREAK') ||
    s.includes('DEXINDEX') ||
    s.startsWith('R_') ||
    s.includes('SYNTH')
  );
}

function stopOnCorrectSide(direction, entry, sl) {
  const d = String(direction || '').toLowerCase();
  if (!Number.isFinite(entry) || !Number.isFinite(sl)) return false;
  if (d === 'long' || d === 'buy') return sl < entry;
  if (d === 'short' || d === 'sell') return sl > entry;
  return false;
}

function candidateDistance(entry, sl) {
  return Math.abs(Number(entry) - Number(sl));
}

/**
 * Build ordered stop candidates (risk-validity first).
 * @returns {{ kind: string, sl: number }[]}
 */
function buildStopCandidates({
  direction,
  entry,
  sweepExtreme,
  fvgTop,
  fvgBot,
  atr,
  bufferAtrRatio = 0.05,
  stopModel = 'sweep',
  symbol = ''
}) {
  const buf = Math.max(0, Number(bufferAtrRatio) || 0) * (Number(atr) || 0);
  const d = String(direction || '').toLowerCase();
  const isLong = d === 'long' || d === 'buy';

  const sweepSl = isLong
    ? Number(sweepExtreme) - buf
    : Number(sweepExtreme) + buf;
  const fvgSl = isLong ? Number(fvgBot) - buf : Number(fvgTop) + buf;

  const sweepOk = Number.isFinite(sweepSl) && stopOnCorrectSide(direction, entry, sweepSl);
  const fvgOk = Number.isFinite(fvgSl) && stopOnCorrectSide(direction, entry, fvgSl);

  const synthetic = isSyntheticSymbol(symbol);
  const model = String(stopModel || 'sweep').toLowerCase();
  const ordered = [];

  const pushUnique = (kind, sl, ok) => {
    if (!ok) return;
    if (ordered.some((c) => c.kind === kind)) return;
    ordered.push({ kind, sl });
  };

  if (synthetic) {
    // JUMP/synthetics: prefer tighter FVG/local before distant HTF sweep.
    pushUnique('fvg', fvgSl, fvgOk);
    pushUnique('sweep', sweepSl, sweepOk);
    return ordered;
  }

  if (model === 'fvg') {
    pushUnique('fvg', fvgSl, fvgOk);
    pushUnique('sweep', sweepSl, sweepOk);
  } else if (model === 'sweep_or_fvg') {
    // Prefer the closer valid structural stop (risk validity), not the farther one.
    if (sweepOk && fvgOk) {
      const sweepDist = candidateDistance(entry, sweepSl);
      const fvgDist = candidateDistance(entry, fvgSl);
      if (fvgDist <= sweepDist) {
        pushUnique('fvg', fvgSl, true);
        pushUnique('sweep', sweepSl, true);
      } else {
        pushUnique('sweep', sweepSl, true);
        pushUnique('fvg', fvgSl, true);
      }
    } else {
      pushUnique('sweep', sweepSl, sweepOk);
      pushUnique('fvg', fvgSl, fvgOk);
    }
  } else {
    // sweep (default): try configured structural first, then FVG fallback.
    pushUnique('sweep', sweepSl, sweepOk);
    pushUnique('fvg', fvgSl, fvgOk);
  }

  return ordered;
}

/**
 * Resolve a valid SL within maxStopAtrMult × ATR, or reject.
 */
function resolveValidStop(params = {}) {
  const entry = Number(params.entry);
  const atrVal = Number(params.atr);
  const maxStopAtrMult = Number(params.maxStopAtrMult);
  const maxDistance =
    Number.isFinite(atrVal) && atrVal > 0 && Number.isFinite(maxStopAtrMult) && maxStopAtrMult > 0
      ? atrVal * maxStopAtrMult
      : Infinity;

  const candidates = buildStopCandidates(params);
  const evaluated = [];

  for (const c of candidates) {
    const distance = candidateDistance(entry, c.sl);
    const row = {
      kind: c.kind,
      sl: c.sl,
      distance,
      withinLimit: Number.isFinite(distance) && distance > 0 && distance <= maxDistance
    };
    evaluated.push(row);
    if (row.withinLimit) {
      return {
        ok: true,
        reason: null,
        sl: c.sl,
        kind: c.kind,
        distance,
        maxDistance: Number.isFinite(maxDistance) ? maxDistance : null,
        atr: atrVal,
        maxStopAtrMult,
        candidates: evaluated
      };
    }
  }

  const best = evaluated[0] || null;
  return {
    ok: false,
    reason: 'SIGNAL_REJECTED_SL_TOO_FAR',
    sl: null,
    kind: best?.kind || null,
    distance: best?.distance ?? null,
    maxDistance: Number.isFinite(maxDistance) ? maxDistance : null,
    atr: atrVal,
    maxStopAtrMult,
    candidates: evaluated
  };
}

/**
 * Validate TP1 reward/risk against minimum RR using FINAL SL.
 */
function validateMinRr({ direction, entry, sl, tp1, minRr }) {
  const risk = Math.abs(Number(entry) - Number(sl));
  const reward = Math.abs(Number(tp1) - Number(entry));
  const floor = Number(minRr);
  if (!(risk > 0) || !(reward > 0) || !Number.isFinite(floor) || floor <= 0) {
    return { ok: true, rr: risk > 0 ? reward / risk : null, reason: null };
  }

  const d = String(direction || '').toLowerCase();
  const isLong = d === 'long' || d === 'buy';
  if (isLong && !(Number(tp1) > Number(entry))) {
    return { ok: false, rr: null, reason: 'SIGNAL_REJECTED_RR_TOO_LOW' };
  }
  if (!isLong && !(Number(tp1) < Number(entry))) {
    return { ok: false, rr: null, reason: 'SIGNAL_REJECTED_RR_TOO_LOW' };
  }

  const rr = reward / risk;
  if (rr + 1e-12 < floor) {
    return { ok: false, rr, reason: 'SIGNAL_REJECTED_RR_TOO_LOW' };
  }
  return { ok: true, rr, reason: null };
}

/**
 * Escape a string for safe inclusion inside a Pine-built JSON string value.
 */
function escapeJsonString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

module.exports = {
  isSyntheticSymbol,
  stopOnCorrectSide,
  candidateDistance,
  buildStopCandidates,
  resolveValidStop,
  validateMinRr,
  escapeJsonString
};
