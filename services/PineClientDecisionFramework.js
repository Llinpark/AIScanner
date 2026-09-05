/**
 * Backend decision framework stubs for future Group-B move from Pine.
 *
 * ALL METHODS ARE PASS-THROUGH / NO-OP while feature flags are OFF.
 * Do NOT enable backend scoring, TP generation, or filtering here yet.
 */

'use strict';

const { getFeatureFlags, isFeatureEnabled } = require('../utils/FeatureFlags');
const {
  extractPineClientMeta,
  COMPAT_MODE
} = require('../utils/PineClientVersion');
const { parseOptionalWebhookContext } = require('../utils/PineWebhookContext');

/**
 * Build a decision context from webhook body (read-only metadata).
 * @param {object} body
 * @param {object} [signalData]
 */
function buildDecisionContext(body = {}, signalData = null) {
  const client = extractPineClientMeta(body);
  const flags = getFeatureFlags();
  const pineContext = parseOptionalWebhookContext(body);
  return {
    client,
    flags,
    pineContext,
    signalData,
    // Shadow mode placeholder: log-only comparisons later; never mutates delivery today.
    shadowMode: false
  };
}

/**
 * Future: backend confidence scoring. Today: return payload confidence unchanged.
 * @param {object} signalData
 * @param {object} [context]
 */
function scoreConfidence(signalData, context = {}) {
  void context;
  if (!signalData || typeof signalData !== 'object') return signalData;
  // Flags OFF ⇒ never rescore.
  if (!isFeatureEnabled('enableSmartScore')) return signalData;
  // Reserved: when enabled + capability present, rescore from factors.
  return signalData;
}

/**
 * Future: dynamic / ATR TP adjustment. Today: pass-through.
 * @param {object} signalData
 * @param {object} [context]
 */
function applyDynamicTakeProfits(signalData, context = {}) {
  void context;
  if (!signalData || typeof signalData !== 'object') return signalData;
  if (!isFeatureEnabled('enableDynamicTP') && !isFeatureEnabled('enableATRTargets')) {
    return signalData;
  }
  return signalData;
}

/**
 * Future: adaptive TF preference filter. Today: never filter.
 * @param {object} signalData
 * @param {object} [context]
 * @returns {{ allow: boolean, signalData: object, reason: string|null }}
 */
function applyAdaptiveTfPolicy(signalData, context = {}) {
  void context;
  return { allow: true, signalData, reason: null };
}

/**
 * Future: trend-bias filter/boost. Today: pass-through.
 * @param {object} signalData
 * @param {object} [context]
 */
function applyTrendBias(signalData, context = {}) {
  void context;
  if (!isFeatureEnabled('enableTrendBias')) return signalData;
  return signalData;
}

/**
 * Future: liquidity ranking for TP sources. Today: pass-through.
 * @param {object} signalData
 * @param {object} [context]
 */
function applyLiquidityRanking(signalData, context = {}) {
  void context;
  if (!isFeatureEnabled('enableLiquidityRanking')) return signalData;
  return signalData;
}

/**
 * Master entry hook for future decision layer.
 *
 * Pass-through only today:
 * - Legacy + Current (v1) ⇒ Pine authoritative; never rescore / rewrite / filter / reject
 * - Future majors ⇒ stub pipeline still returns proceed:true (no Group-B impl yet)
 * Webhook callers must ignore proceed for delivery until product enables gates.
 *
 * @param {object} body
 * @param {object} signalData
 */
function evaluateEntryDecision(body, signalData) {
  const context = buildDecisionContext(body, signalData);

  // Missing version, unparseable, older majors, and stamped v1 Current:
  // trust Pine entry/confidence/SL/TP — no backend decision gates.
  if (
    context.client.isLegacy ||
    context.client.mode === COMPAT_MODE.LEGACY ||
    context.client.mode === COMPAT_MODE.CURRENT
  ) {
    return {
      proceed: true,
      signalData,
      context,
      applied: []
    };
  }

  // FUTURE mode: run stub hooks for readiness / shadow wiring later.
  // Implementations remain no-ops while flags are OFF; never reject.
  let next = signalData;
  const applied = [];

  next = scoreConfidence(next, context);
  next = applyDynamicTakeProfits(next, context);
  next = applyTrendBias(next, context);
  next = applyLiquidityRanking(next, context);
  const tf = applyAdaptiveTfPolicy(next, context);
  next = tf.signalData;
  void tf;

  return { proceed: true, signalData: next, context, applied };
}

module.exports = {
  buildDecisionContext,
  scoreConfidence,
  applyDynamicTakeProfits,
  applyAdaptiveTfPolicy,
  applyTrendBias,
  applyLiquidityRanking,
  evaluateEntryDecision
};
