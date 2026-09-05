/**
 * Context-only webhook field parsers (Phase 7 prep).
 *
 * Accept optional future context fields when present; ignore when absent.
 * Never required. Never changes delivery / scoring / SL/TP today.
 */

'use strict';

function toFiniteNumber(value) {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

function toOptionalBool(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return undefined;
}

function toOptionalString(value) {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

/**
 * Parse optional context fields from a TradingView webhook body.
 * Missing fields ⇒ undefined (legacy payloads remain valid).
 *
 * @param {object} body
 * @returns {object} sparse context object (only defined keys)
 */
function parseOptionalWebhookContext(body = {}) {
  const atr =
    toFiniteNumber(body.atr14) ??
    toFiniteNumber(body.atr) ??
    toFiniteNumber(body.atrContext) ??
    toFiniteNumber(body.atr_context);

  const volatility =
    toFiniteNumber(body.volatility) ??
    toFiniteNumber(body.volatilityScore) ??
    toFiniteNumber(body.volatility_score);

  const htfBias =
    toOptionalString(body.htfBias) ??
    toOptionalString(body.htf_bias) ??
    toOptionalString(body.trendBias) ??
    toOptionalString(body.trend_bias);

  const sweepQuality =
    toFiniteNumber(body.sweepQuality) ??
    toFiniteNumber(body.sweep_quality);

  const fvgSize =
    toFiniteNumber(body.fvgSize) ??
    toFiniteNumber(body.fvg_size) ??
    toFiniteNumber(body.gapSizeAtr) ??
    toFiniteNumber(body.gap_size_atr);

  const trendStrength =
    toFiniteNumber(body.trendStrength) ??
    toFiniteNumber(body.trend_strength);

  let confidenceFactors =
    body.confidenceFactors ??
    body.confidence_factors ??
    body.factors ??
    undefined;

  if (typeof confidenceFactors === 'string') {
    try {
      confidenceFactors = JSON.parse(confidenceFactors);
    } catch {
      confidenceFactors = undefined;
    }
  }
  if (confidenceFactors != null && typeof confidenceFactors !== 'object') {
    confidenceFactors = undefined;
  }

  const ctx = {};
  if (atr !== undefined) ctx.atr14 = atr;
  if (volatility !== undefined) ctx.volatility = volatility;
  if (htfBias !== undefined) ctx.htfBias = htfBias;
  if (sweepQuality !== undefined) ctx.sweepQuality = sweepQuality;
  if (fvgSize !== undefined) ctx.fvgSize = fvgSize;
  if (trendStrength !== undefined) ctx.trendStrength = trendStrength;
  if (confidenceFactors !== undefined) ctx.confidenceFactors = confidenceFactors;

  const hasEngulf = toOptionalBool(body.hasEngulfing ?? body.has_engulfing ?? body.engulfing);
  if (hasEngulf !== undefined) ctx.hasEngulfing = hasEngulf;

  return ctx;
}

/**
 * Attach parsed context under signalData.pineContext without mutating required fields.
 * Safe no-op when body has no optional context.
 *
 * @param {object} signalData
 * @param {object} body
 * @returns {object} signalData (same reference)
 */
function attachOptionalContext(signalData, body) {
  if (!signalData || typeof signalData !== 'object') return signalData;
  const ctx = parseOptionalWebhookContext(body || {});
  if (Object.keys(ctx).length) {
    signalData.pineContext = { ...(signalData.pineContext || {}), ...ctx };
  }
  return signalData;
}

module.exports = {
  parseOptionalWebhookContext,
  attachOptionalContext,
  toFiniteNumber,
  toOptionalBool
};
