import { normalizeInterval } from '../utils/chartLevels';

export const TIER_TIMEFRAMES = {
  basic: ['1h', '15m', '3m', '1m'],
  professional: ['4h', '1h', '30m', '15m', '5m', '1m'],
  premium: ['1M', '1W', '1D', '4h', '1h', '30m', '15m', '5m', '1m']
};

export const TIER_LABELS = {
  basic: 'Basic',
  professional: 'Pro',
  premium: 'Premium'
};

const TIMEFRAME_MIN_TIER = {
  '1m': 'basic',
  '5m': 'professional',
  '15m': 'basic',
  '30m': 'professional',
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
