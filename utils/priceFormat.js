/**
 * Universal TradingView-style price display helpers.
 * No symbol allowlists / forex-only toFixed(5) — derive decimals from mintick (or infer step).
 */

/** Decimal places implied by a mintick/step: 0.00001→5, 0.01→2, 1→0. */
function decimalsFromMintick(mintick) {
  let tick = Math.abs(Number(mintick));
  if (!Number.isFinite(tick) || tick <= 0) return 8;
  let decimals = 0;
  while (tick < 1 && decimals < 12) {
    tick *= 10;
    decimals += 1;
    if (Math.abs(tick - Math.round(tick)) < 1e-8) break;
  }
  return decimals;
}

/**
 * When mintick is unknown (webhook display), infer a step from price magnitude only.
 * Not symbol-specific — works for FX, metals, crypto, indices, synthetics.
 */
function inferMintickFromPrice(value) {
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n) || n === 0) return 1e-5;
  if (n >= 1000) return 0.01;
  if (n >= 100) return 0.01;
  if (n >= 10) return 0.001;
  if (n >= 1) return 1e-5;
  return 1e-6;
}

/**
 * Format a price for display / email / Telegram.
 * Optional second arg: mintick number. Strings (symbols) are ignored — step is inferred.
 */
function formatTvPrice(value, mintick) {
  if (value === undefined || value === null || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  let step = Number(mintick);
  if (!Number.isFinite(step) || step <= 0) {
    step = inferMintickFromPrice(n);
  }
  return n.toFixed(decimalsFromMintick(step));
}

module.exports = {
  decimalsFromMintick,
  inferMintickFromPrice,
  formatTvPrice
};
