/**
 * Universal instrument price formatting — no symbol whitelist / forex-only decimals.
 * Prefer an explicit mintick; otherwise infer step from price magnitude.
 */

/** Decimal places implied by a mintick/step: 0.00001→5, 0.01→2, 1→0. */
export function decimalsFromMintick(mintick) {
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

/** Infer mintick from a sample price when TV mintick is unavailable. */
export function inferMintickFromPrice(value) {
  const n = Math.abs(Number(value));
  if (!Number.isFinite(n) || n === 0) return 1e-5;
  if (n >= 1000) return 0.01;
  if (n >= 100) return 0.01;
  if (n >= 10) return 0.001;
  if (n >= 1) return 1e-5;
  return 1e-6;
}

/**
 * @param {number} value
 * @param {number|string} [mintickOrHint] mintick number, or ignored symbol string (step inferred from value)
 */
export function getPricePrecision(valueOrMintick, maybeMintick) {
  const asNumber = Number(valueOrMintick);
  let mintick = Number(maybeMintick);
  if (Number.isFinite(mintick) && mintick > 0) {
    return { precision: decimalsFromMintick(mintick), minMove: mintick };
  }
  // Legacy call shape: getPricePrecision(symbol) — ignore symbol, use default FX-like step
  // Prefer getPricePrecision(samplePrice) / formatInstrumentPrice(value, mintick).
  if (!Number.isFinite(asNumber) || asNumber <= 0 || asNumber > 1) {
    const sample = Number.isFinite(asNumber) && asNumber > 1 ? asNumber : 1.085;
    mintick = inferMintickFromPrice(sample);
  } else {
    // valueOrMintick looks like a mintick itself
    mintick = asNumber;
  }
  return { precision: decimalsFromMintick(mintick), minMove: mintick };
}

export function formatInstrumentPrice(value, mintickOrHint) {
  if (!Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  let mintick = Number(mintickOrHint);
  if (!Number.isFinite(mintick) || mintick <= 0) {
    mintick = inferMintickFromPrice(n);
  }
  return n.toFixed(decimalsFromMintick(mintick));
}

/** Lightweight Charts priceFormat from a sample price (not a symbol name). */
export function getChartPriceFormat(samplePrice) {
  const mintick = inferMintickFromPrice(samplePrice);
  const precision = decimalsFromMintick(mintick);
  return {
    type: 'price',
    precision,
    minMove: mintick
  };
}
