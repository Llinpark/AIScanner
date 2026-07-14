const {
  TIER_FEATURES,
  TIER_ORDER,
  TIER_DISPLAY_NAMES,
  ALL_CURRENCY_PAIRS
} = require('../config/subscriptions');
const { normalizeSymbol } = require('../config/symbols');

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
  const tier = subscription?.tier || 'basic';
  return TIER_FEATURES[tier] ? tier : 'basic';
}

function getTierFeatures(subscriptionOrTier) {
  const tier =
    typeof subscriptionOrTier === 'string'
      ? subscriptionOrTier
      : getTierName(subscriptionOrTier);
  return TIER_FEATURES[tier] || TIER_FEATURES.basic;
}

function getTierDisplayName(tierKey) {
  return TIER_DISPLAY_NAMES[tierKey] || tierKey;
}

function getAllowedCurrencyPairs(subscription) {
  const pairs = getTierFeatures(subscription).currencyPairs || ALL_CURRENCY_PAIRS;
  return pairs.map(normalizeSymbol);
}

function getAllowedTimeframes(subscription) {
  return getTierFeatures(subscription).timeframes || ['1h'];
}

function isCurrencyPairAllowed(symbol, subscription) {
  const normalized = normalizeSymbol(symbol);
  return getAllowedCurrencyPairs(subscription).includes(normalized);
}

function isTimeframeAllowed(interval, subscription) {
  const allowed = getAllowedTimeframes(subscription);
  return allowed.includes(String(interval || '').trim());
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

module.exports = {
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
  hasTierFeature
};
