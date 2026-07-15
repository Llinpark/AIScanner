import { normalizeInterval } from '../utils/chartLevels';

export const CHART_TIMEFRAME_OPTIONS = [
  { label: '1m', apiInterval: '1m' },
  { label: '5m', apiInterval: '5m' },
  { label: '15m', apiInterval: '15m' },
  { label: '30m', apiInterval: '30m' },
  { label: '1H', apiInterval: '1h' },
  { label: '4H', apiInterval: '4h' },
  { label: 'D', apiInterval: '1d' },
  { label: '1W', apiInterval: '1w' }
];

export function isChartTimeframeAllowed(apiInterval, allowedTimeframes = []) {
  const canonical = normalizeInterval(apiInterval);
  return (allowedTimeframes || []).some(tf => normalizeInterval(tf) === canonical);
}

export function defaultApiInterval(allowedTimeframes = ['1h']) {
  const match = CHART_TIMEFRAME_OPTIONS.find(option =>
    isChartTimeframeAllowed(option.apiInterval, allowedTimeframes)
  );
  if (match) return match.apiInterval;

  const first = allowedTimeframes[0] || '1h';
  const byCanonical = CHART_TIMEFRAME_OPTIONS.find(
    option => normalizeInterval(option.apiInterval) === normalizeInterval(first)
  );
  return byCanonical?.apiInterval || normalizeInterval(first);
}

export function timeframeLabel(apiInterval) {
  const match = CHART_TIMEFRAME_OPTIONS.find(
    option => normalizeInterval(option.apiInterval) === normalizeInterval(apiInterval)
  );
  return match?.label || apiInterval;
}
