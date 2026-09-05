/** Keep in sync with backend `SCANNER_PREMIUM_THRESHOLD` default (patternScanner.js). */
export const DEFAULT_PREMIUM_SIGNAL_THRESHOLD = 90;

export function formatPremiumThresholdLabel(threshold = DEFAULT_PREMIUM_SIGNAL_THRESHOLD) {
  const value = Number(threshold);
  if (!Number.isFinite(value) || value <= 0) {
    return `${DEFAULT_PREMIUM_SIGNAL_THRESHOLD}%+`;
  }
  return `${Math.round(value)}%+`;
}

export function premiumSignalsScoredCopy(threshold = DEFAULT_PREMIUM_SIGNAL_THRESHOLD) {
  return `Premium signals scored at ${formatPremiumThresholdLabel(threshold)} confidence`;
}
