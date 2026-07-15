import { normalizeInterval } from '../utils/chartLevels';

export const TIER_TIMEFRAMES = {
  basic: ['1m', '1h'],
  professional: ['1m', '15m', '1h', '4h'],
  premium: ['1m', '5m', '15m', '30m', '1h', '4h', '1D', '1W']
};

export const TIER_LABELS = {
  basic: 'Basic',
  professional: 'Pro',
  premium: 'Premium'
};

const TIMEFRAME_MIN_TIER = {
  '1m': 'basic',
  '5m': 'premium',
  '15m': 'professional',
  '30m': 'premium',
  '1h': 'basic',
  '4h': 'professional',
  '1d': 'premium',
  '1w': 'premium'
};

export function getTimeframesForTier(tier) {
  return TIER_TIMEFRAMES[tier] || TIER_TIMEFRAMES.basic;
}

export function getMinimumTierForTimeframe(apiInterval) {
  const canonical = normalizeInterval(apiInterval);
  return TIMEFRAME_MIN_TIER[canonical] || 'premium';
}

export function getUpgradeLabelForTimeframe(apiInterval) {
  const tier = getMinimumTierForTimeframe(apiInterval);
  return `${TIER_LABELS[tier]} plan`;
}

export function isTimeframeAllowedForTier(apiInterval, tier) {
  return getTimeframesForTier(tier).some(
    allowed => normalizeInterval(allowed) === normalizeInterval(apiInterval)
  );
}
