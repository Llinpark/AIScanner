/**
 * Pro Manual Confirmation window helpers.
 * Only two execution modes exist: manual (Pro) and auto (Premium).
 * Confirmation TTL is clamped to 2–5 minutes (default 3).
 */

const CONFIRM_MIN_SECONDS = 120;
const CONFIRM_MAX_SECONDS = 300;
const CONFIRM_DEFAULT_SECONDS = 180;

function clampConfirmSeconds(value, fallback = CONFIRM_DEFAULT_SECONDS) {
  const n = Number(value);
  const base = Number.isFinite(n) ? n : Number(fallback) || CONFIRM_DEFAULT_SECONDS;
  return Math.min(CONFIRM_MAX_SECONDS, Math.max(CONFIRM_MIN_SECONDS, Math.round(base)));
}

/**
 * Resolve TTL seconds: user mt5.manualConfirmSeconds → env → default.
 */
function resolveConfirmSeconds(userOrMt5 = null) {
  const mt5 = userOrMt5?.mt5 || userOrMt5 || {};
  if (mt5.manualConfirmSeconds != null) {
    return clampConfirmSeconds(mt5.manualConfirmSeconds);
  }
  if (process.env.MT5_MANUAL_CONFIRM_SECONDS != null) {
    return clampConfirmSeconds(process.env.MT5_MANUAL_CONFIRM_SECONDS);
  }
  return CONFIRM_DEFAULT_SECONDS;
}

function computeConfirmExpiresAt(fromDate = new Date(), seconds = CONFIRM_DEFAULT_SECONDS) {
  const ttl = clampConfirmSeconds(seconds);
  const start = fromDate instanceof Date ? fromDate.getTime() : Date.now();
  return new Date(start + ttl * 1000);
}

function isConfirmExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return false;
  const exp = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
  if (!Number.isFinite(exp)) return false;
  return now.getTime() >= exp;
}

function formatConfirmWindowLabel(seconds) {
  const s = clampConfirmSeconds(seconds);
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s}s`;
}

module.exports = {
  CONFIRM_MIN_SECONDS,
  CONFIRM_MAX_SECONDS,
  CONFIRM_DEFAULT_SECONDS,
  clampConfirmSeconds,
  resolveConfirmSeconds,
  computeConfirmExpiresAt,
  isConfirmExpired,
  formatConfirmWindowLabel
};
