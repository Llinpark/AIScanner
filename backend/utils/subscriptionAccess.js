const {
  TIER_FEATURES,
  TIER_ORDER,
  TIER_DISPLAY_NAMES,
  ALL_CURRENCY_PAIRS
} = require('../config/subscriptions');
const { normalizeSymbol } = require('../config/symbols');
const { isAdmin } = require('./adminAccess');

/** Far-future period end so admin bypass stays "active" in expiry checks. */
const ADMIN_ACCESS_PERIOD_END = new Date('2099-12-31T23:59:59.000Z');

function hasFullAccess(user) {
  return isAdmin(user);
}

/**
 * Computed subscription used for feature gates and API/UI responses.
 * Admins/super_admins get active premium without requiring a paid plan in DB.
 */
function getEffectiveSubscription(user) {
  if (!user) {
    return { status: 'inactive', tier: 'basic' };
  }

  const raw = user.subscription?.toObject?.() || user.subscription || {};

  if (!hasFullAccess(user)) {
    return {
      ...raw,
      status: raw.status || 'inactive',
      tier: raw.tier || 'basic'
    };
  }

  return {
    ...raw,
    tier: 'premium',
    status: 'active',
    provider: raw.provider || 'admin',
    billingCycle: raw.billingCycle || 'monthly',
    current_period_end: ADMIN_ACCESS_PERIOD_END,
    adminBypass: true
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
  if (subscription.status === 'active') {
    if (subscription.current_period_end && new Date(subscription.current_period_end) < new Date()) {
      return false;
    }
    return true;
  }
  return false;
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

function isCurrencyPairAllowed(symbol, subscription) {
  const normalized = normalizeSymbol(symbol);
  return getAllowedCurrencyPairs(subscription).includes(normalized);
}

function isTimeframeAllowed(interval, subscription) {
  const canonical = normalizeInterval(interval);
  return getAllowedTimeframes(subscription).some(
    allowed => normalizeInterval(allowed) === canonical
  );
}

function historyCutoffDate(subscription) {
  const { historyDays } = getTierFeatures(subscription);
  return new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000);
}

function sanitizeSignalForTier(signal, subscription) {
  const features = getTierFeatures(subscription);
  const doc = signal.toObject ? signal.toObject() : { ...signal };

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

function filterSignalsForTier(signals, subscription) {
  const allowedPairs = getAllowedCurrencyPairs(subscription);
  return signals.filter(signal => allowedPairs.includes(normalizeSymbol(signal.symbol)));
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
  getTierName,
  getTierFeatures,
  getTierDisplayName,
  normalizeSymbol,
  getAllowedCurrencyPairs,
  getAllowedTimeframes,
  isCurrencyPairAllowed,
  isTimeframeAllowed,
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
