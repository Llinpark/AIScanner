/**
 * Lightweight high-impact news window detector for Pro/Premium news filter.
 * Heuristic calendar (no external API) — flags common USD risk windows.
 */

function isFirstFriday(date) {
  return date.getUTCDay() === 5 && date.getUTCDate() <= 7;
}

/**
 * @param {Date} [at]
 * @returns {{ impact: 'high'|'medium'|'low'|'none', label: string, avoidNewEntries: boolean, window: string|null }}
 */
function evaluateNewsImpact(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) {
    return { impact: 'none', label: 'No elevated news risk', avoidNewEntries: false, window: null };
  }

  const day = d.getUTCDay(); // 0=Sun
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const mins = hour * 60 + minute;

  // NFP: first Friday of month, ~12:30–14:30 UTC
  if (isFirstFriday(d) && mins >= 12 * 60 + 15 && mins <= 14 * 60 + 30) {
    return {
      impact: 'high',
      label: 'NFP / US employment window — elevated USD volatility',
      avoidNewEntries: true,
      window: 'nfp'
    };
  }

  // Typical US CPI / retail sales release hour (Wed/Thu ~12:30–14:00 UTC heuristic)
  if ((day === 3 || day === 4) && mins >= 12 * 60 + 20 && mins <= 14 * 60) {
    return {
      impact: 'medium',
      label: 'Possible US data release window — trade with caution',
      avoidNewEntries: false,
      window: 'us_data'
    };
  }

  // London open / NY open overlap risk
  if (day >= 1 && day <= 5 && mins >= 12 * 60 && mins <= 13 * 60 + 30) {
    return {
      impact: 'low',
      label: 'London–NY overlap — normal session volatility',
      avoidNewEntries: false,
      window: 'session_overlap'
    };
  }

  return {
    impact: 'none',
    label: 'No elevated news risk detected',
    avoidNewEntries: false,
    window: null
  };
}

function attachNewsFilterToSignal(signal, at = new Date()) {
  const evaluation = evaluateNewsImpact(at);
  return {
    ...signal,
    newsImpact: evaluation.impact,
    newsFilter: evaluation
  };
}

module.exports = {
  evaluateNewsImpact,
  attachNewsFilterToSignal,
  isFirstFriday
};
