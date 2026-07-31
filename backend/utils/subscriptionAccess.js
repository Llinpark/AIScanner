const {
  TIER_FEATURES,
  TIER_ORDER,
  TIER_DISPLAY_NAMES,
  ALL_CURRENCY_PAIRS
} = require('../config/subscriptions');
const { normalizeSymbol } = require('../config/symbols');
const { isAdmin, isSuperAdmin } = require('./adminAccess');
const { isWebhookInsightsSignal } = require('./insightsSignalFilter');

function hasFullAccess(user) {
  return isAdmin(user);
}

function adminPlanLabel(user) {
  return isSuperAdmin(user) ? 'Super Admin' : 'Administrator';
}

/**
 * Computed subscription used for feature gates and API/UI responses.
 * Admins/super_admins get active premium without a paid plan or fake period end.
 */
function getEffectiveSubscription(user) {
  if (!user) {
    return { status: 'inactive', tier: 'basic', remainingDays: null };
  }

  const raw = user.subscription?.toObject?.() || user.subscription || {};

  if (!hasFullAccess(user)) {
    const status = raw.status || 'inactive';
    const enriched = {
      ...raw,
      status,
      tier: raw.tier || 'basic',
      startDate: raw.startDate || null,
      expiryDate: raw.current_period_end || null,
      remainingDays: remainingDays(raw),
      paymentSource: raw.paymentSource || null
    };
    // Treat past-due active rows as expired for API consumers (job also flips DB).
    if (status === 'active' && !isSubscriptionActive(enriched)) {
      return { ...enriched, status: 'expired', remainingDays: 0 };
    }
    return enriched;
  }

  const planLabel = adminPlanLabel(user);
  return {
    ...raw,
    tier: 'premium',
    status: 'active',
    provider: raw.provider || 'admin',
    paymentSource: raw.paymentSource || 'ADMIN',
    billingCycle: null,
    startDate: raw.startDate || null,
    // Role-based unlimited access — never invent a sentinel expiry year.
    current_period_end: null,
    expiryDate: null,
    remainingDays: null,
    adminBypass: true,
    unlimitedAccess: true,
    planLabel,
    statusLabel: 'Unlimited Access',
    expiresLabel: 'Never'
  };
}

/** Plain request-scoped user with effective subscription (does not mutate DB docs). */
function withEffectiveAccess(user) {
  if (!user) return user;
  const base = user.toObject ? user.toObject() : { ...user };
  return {
    ...base,
    _id: user._id || base._id,
    id: user._id?.toString?.() || user.id || base.id,
    subscription: getEffectiveSubscription(user)
  };
}

function isSubscriptionActive(subscription) {
  if (!subscription) return false;
  // Admin role bypass — unlimited access without a period end.
  if (subscription.adminBypass || subscription.unlimitedAccess) {
    return true;
  }
  // Canonical ACTIVE semantics — stored lowercase 'active' for Mongo compatibility.
  if (subscription.status === 'active' || subscription.status === 'ACTIVE') {
    const expiry = subscription.current_period_end || subscription.expiryDate;
    if (expiry && new Date(expiry) < new Date()) {
      return false;
    }
    return true;
  }
  return false;
}

function remainingDays(subscription) {
  const expiry = subscription?.current_period_end || subscription?.expiryDate;
  if (!expiry) return null;
  const ms = new Date(expiry).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function getTierName(subscription) {
  const tier = String(subscription?.tier || 'basic').trim().toLowerCase();
  return TIER_FEATURES[tier] ? tier : 'basic';
}

function getTierFeatures(subscriptionOrTier) {
  const tier =
    typeof subscriptionOrTier === 'string'
      ? subscriptionOrTier
      : getTierName(subscriptionOrTier);
  const features = TIER_FEATURES[tier] || TIER_FEATURES.basic;
  // Premium (and admin bypass) includes API access used by /api/v1/signals.
  if (tier === 'premium' && features.apiAccess == null) {
    return { ...features, apiAccess: true, propFirmMode: true };
  }
  return features;
}

function getTierDisplayName(tierKey) {
  return TIER_DISPLAY_NAMES[tierKey] || tierKey;
}

function getAllowedCurrencyPairs(subscription) {
  const pairs = getTierFeatures(subscription).currencyPairs || ALL_CURRENCY_PAIRS;
  return pairs.map(normalizeSymbol);
}

const { normalizeInterval } = require('./marketIntervals');

function getAllowedTimeframes(subscription) {
  return getTierFeatures(subscription).timeframes || ['1h'];
}

/**
 * Chart / scanner catalog gate — still limited by tier currencyPairs.
 * Do NOT use this to reject TradingView webhook symbols.
 */
function isCurrencyPairAllowed(symbol, subscription) {
  const features = getTierFeatures(subscription);
  // Premium multi-market: chart catalog is advisory; any symbol is allowed for charts too.
  if (features.anyTradingViewInstrument && features.multiMarketScanner) {
    return Boolean(normalizeSymbol(symbol));
  }
  const normalized = normalizeSymbol(symbol);
  return getAllowedCurrencyPairs(subscription).includes(normalized);
}

/**
 * TradingView webhook path: subscribers with TV alerts accept any sanitized instrument.
 * Source of truth is the TradingView chart symbol, not ALL_CURRENCY_PAIRS.
 */
function allowsAnyTradingViewInstrument(subscription) {
  const features = getTierFeatures(subscription);
  if (features.anyTradingViewInstrument != null) {
    return Boolean(features.anyTradingViewInstrument);
  }
  return Boolean(features.tradingViewAlerts);
}

function isTradingViewSymbolAllowed(symbol, subscription) {
  if (!allowsAnyTradingViewInstrument(subscription)) {
    return isCurrencyPairAllowed(symbol, subscription);
  }
  return Boolean(normalizeSymbol(symbol));
}

function isTimeframeAllowed(interval, subscription) {
  const features = getTierFeatures(subscription);
  // Premium (all timeframes) / TV pass-through: do not hard-block exotic chart TFs on webhook path.
  if (features.anyTradingViewInstrument && features.multiMarketScanner) {
    return true;
  }
  const canonical = normalizeInterval(interval);
  return getAllowedTimeframes(subscription).some(
    allowed => normalizeInterval(allowed) === canonical
  );
}

/** Timeframe check for TV webhook distribution — chart TF is source of truth when TV-entitled. */
function isTradingViewTimeframeAllowed(interval, subscription) {
  if (allowsAnyTradingViewInstrument(subscription)) {
    return true;
  }
  return isTimeframeAllowed(interval, subscription);
}

function historyCutoffDate(subscription) {
  const { historyDays } = getTierFeatures(subscription);
  return new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);
}

function sanitizeSignalForTier(signal, subscription) {
  const features = getTierFeatures(subscription);
  const doc = signal.toObject ? signal.toObject() : { ...signal };

  // Never expose legacy pipeline scoring payloads on user-facing responses.
  delete doc.pipelineScore;
  delete doc.pipelineScoreBreakdown;
  delete doc.pipelineSteps;
  delete doc.pipelineVersion;
  if (doc.aiFactors?.source === 'pipeline_scoring' || doc.pattern === 'smc_pipeline') {
    delete doc.aiFactors;
  }
  if (/pipeline\s*score|premium\s*smc\s*pipeline/i.test(String(doc.notes || ''))) {
    delete doc.notes;
  }
  if (/smc\s*pipeline|pipeline\s*signal/i.test(String(doc.patternLabel || ''))) {
    delete doc.patternLabel;
    delete doc.pattern_label;
  }

  if (!features.showConfidence) {
    delete doc.confidence;
  }

  if (!features.newsFilter) {
    delete doc.newsFilter;
    delete doc.newsImpact;
  }

  if (!features.smartMoneyConcepts) {
    delete doc.smc;
    delete doc.smartMoneyConcepts;
    delete doc.orderBlock;
    delete doc.liquidity;
    delete doc.gapTop;
    delete doc.gapBottom;
    delete doc.chartZones;
    delete doc.orderBlockTop;
    delete doc.orderBlockBottom;
    delete doc.orderBlockTimeStart;
    delete doc.orderBlockTimeEnd;
    delete doc.liquidityZoneTop;
    delete doc.liquidityZoneBottom;
    delete doc.liquidityTimeStart;
    delete doc.liquidityTimeEnd;
  }

  if (!features.tradeManagementAlerts) {
    delete doc.tradeManagement;
    delete doc.partialClose;
    delete doc.breakEven;
  }

  if (!features.riskAnalysis) {
    delete doc.riskMetrics;
  }

  if (!features.aiTradeExplanation) {
    delete doc.aiExplanation;
    delete doc.tradeExplanation;
    delete doc.aiFactors;
  }

  if (!features.propFirmMode) {
    delete doc.propFirm;
    delete doc.dailyDrawdown;
    delete doc.maxLoss;
  }

  return doc;
}

/**
 * Tier read filter for user-facing signal feeds.
 * Always drops legacy scanner / SMC pipeline rows.
 * TradingView webhook symbols pass through regardless of chart-catalog pair lists.
 */
function filterSignalsForTier(signals, subscription) {
  const features = getTierFeatures(subscription);
  const allowedPairs = getAllowedCurrencyPairs(subscription);
  const tvPassThrough = allowsAnyTradingViewInstrument(subscription);
  const premiumAllMarkets = Boolean(features.multiMarketScanner);

  return signals.filter(signal => {
    // Mandatory: never surface legacy pipeline / live_scan rows on dashboard feeds.
    if (!isWebhookInsightsSignal(signal)) return false;

    const normalized = normalizeSymbol(signal.symbol);
    if (!normalized) return false;
    if (tvPassThrough) return true;
    if (premiumAllMarkets) return true;
    return allowedPairs.includes(normalized);
  });
}

function minimumTierForFeature(featureKey) {
  for (const tier of TIER_ORDER) {
    if (TIER_FEATURES[tier]?.[featureKey]) {
      return tier;
    }
  }
  return 'premium';
}

function minimumTierDisplayForFeature(featureKey) {
  return getTierDisplayName(minimumTierForFeature(featureKey));
}

function canAccessLiveAlerts(subscription) {
  return isSubscriptionActive(subscription);
}

function canAccessTradingViewAlerts(subscription) {
  return isSubscriptionActive(subscription) && getTierFeatures(subscription).tradingViewAlerts;
}

function hasTierFeature(subscription, featureKey) {
  return Boolean(getTierFeatures(subscription)[featureKey]);
}

/** User-aware wrappers for services that load users from DB (not via requireAuth). */
function userCanAccessLiveAlerts(user) {
  return canAccessLiveAlerts(getEffectiveSubscription(user));
}

function userCanAccessTradingViewAlerts(user) {
  return canAccessTradingViewAlerts(getEffectiveSubscription(user));
}

function userHasTierFeature(user, featureKey) {
  return hasTierFeature(getEffectiveSubscription(user), featureKey);
}

module.exports = {
  hasFullAccess,
  getEffectiveSubscription,
  withEffectiveAccess,
  isSubscriptionActive,
  remainingDays,
  getTierName,
  getTierFeatures,
  getTierDisplayName,
  normalizeSymbol,
  getAllowedCurrencyPairs,
  getAllowedTimeframes,
  isCurrencyPairAllowed,
  isTradingViewSymbolAllowed,
  allowsAnyTradingViewInstrument,
  isTimeframeAllowed,
  isTradingViewTimeframeAllowed,
  historyCutoffDate,
  sanitizeSignalForTier,
  filterSignalsForTier,
  minimumTierForFeature,
  minimumTierDisplayForFeature,
  canAccessLiveAlerts,
  canAccessTradingViewAlerts,
  hasTierFeature,
  userCanAccessLiveAlerts,
  userCanAccessTradingViewAlerts,
  userHasTierFeature
};
