/**
 * Pro Telegram behaviour preference (additive).
 *
 * Does NOT change executionMode (still only auto | manual).
 * Only applies when executionMode === 'manual' (Professional).
 * Premium (auto) completely ignores this field — including leftover alerts_only.
 *
 * Values:
 *   manual_confirmation — Telegram Execute/Ignore → MT5 queue (default)
 *   alerts_only         — Telegram alert only; no MT5 queue / buttons
 */

const { userHasTierFeature } = require('./subscriptionAccess');

const TELEGRAM_MODES = Object.freeze({
  MANUAL_CONFIRMATION: 'manual_confirmation',
  ALERTS_ONLY: 'alerts_only'
});

function normalizeTelegramMode(raw) {
  if (raw == null || raw === '') return null;
  const key = String(raw).trim().toLowerCase();
  if (key === TELEGRAM_MODES.ALERTS_ONLY || key === 'alerts' || key === 'telegram_alerts') {
    return TELEGRAM_MODES.ALERTS_ONLY;
  }
  if (
    key === TELEGRAM_MODES.MANUAL_CONFIRMATION ||
    key === 'manual' ||
    key === 'telegram_manual'
  ) {
    return TELEGRAM_MODES.MANUAL_CONFIRMATION;
  }
  return null;
}

/**
 * Resolve stored telegramMode for a user (raw preference).
 * Missing / unknown → manual_confirmation (backward compatible).
 * Premium ignores this for routing — use isAlertsOnlyTelegram for gating.
 */
function resolveTelegramMode(user) {
  const fromTelegram = normalizeTelegramMode(user?.telegram?.telegramMode);
  if (fromTelegram) return fromTelegram;
  // Tolerate accidental storage on preferences during early drafts.
  const fromPrefs = normalizeTelegramMode(user?.preferences?.telegramMode);
  if (fromPrefs) return fromPrefs;
  return TELEGRAM_MODES.MANUAL_CONFIRMATION;
}

/**
 * True only on the Professional / manual execution path with alerts_only.
 * Premium (mt5AutoExecution) always returns false — leftover telegramMode is ignored.
 */
function isAlertsOnlyTelegram(user) {
  if (!user) return false;
  if (resolveTelegramMode(user) !== TELEGRAM_MODES.ALERTS_ONLY) return false;
  // Premium completely ignores telegramMode.
  if (userHasTierFeature(user, 'mt5AutoExecution')) return false;
  const executionMode = String(user?.mt5?.executionMode || 'manual').toLowerCase();
  // Prefer: only when executionMode is manual (Pro path).
  return executionMode !== 'auto';
}

function isManualConfirmationTelegram(user) {
  if (!user) return false;
  // Premium ignores telegramMode preference for Pro behaviour helpers.
  if (userHasTierFeature(user, 'mt5AutoExecution')) return false;
  return resolveTelegramMode(user) === TELEGRAM_MODES.MANUAL_CONFIRMATION;
}

function coerceWritableTelegramMode(requested) {
  return normalizeTelegramMode(requested) || null;
}

module.exports = {
  TELEGRAM_MODES,
  normalizeTelegramMode,
  resolveTelegramMode,
  isAlertsOnlyTelegram,
  isManualConfirmationTelegram,
  coerceWritableTelegramMode
};
