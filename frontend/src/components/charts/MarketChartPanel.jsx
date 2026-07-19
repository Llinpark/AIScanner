import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  defaultApiInterval,
  isChartTimeframeAllowed
} from '../../constants/chartTimeframes';
import { getTimeframesForTier } from '../../constants/subscriptionLimits';
import { useAuth } from '../../context/AuthContext';
import useLiveChartLevels from '../../hooks/useLiveChartLevels';
import useMarketCandles from '../../hooks/useMarketCandles';
import ChartTimeframeToolbar from './ChartTimeframeToolbar';
import KachingLightweightChart from './KachingLightweightChart';

export default function MarketChartPanel({
  symbol,
  interval: controlledInterval,
  onIntervalChange,
  allowedTimeframes: allowedTimeframesProp,
  allowedSymbols = [],
  onSymbolChange,
  overlaySignals = [],
  useLiveLevels = true,
  subscribed = true,
  liveEnabled = true,
  height = 600
}) {
  const SYMBOL_DEBOUNCE_MS = 400;
  const { subscription, isAuthenticated } = useAuth();
  const tier = subscription?.tier || 'basic';
  const [debouncedSymbol, setDebouncedSymbol] = useState(symbol);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSymbol(symbol), SYMBOL_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [symbol]);

  const allowedTimeframes = useMemo(() => {
    if (Array.isArray(allowedTimeframesProp) && allowedTimeframesProp.length > 0) {
      return allowedTimeframesProp;
    }
    return getTimeframesForTier(tier);
  }, [allowedTimeframesProp, tier]);

  const isControlled = controlledInterval !== undefined;
  const [internalInterval, setInternalInterval] = useState(() =>
    defaultApiInterval(allowedTimeframes)
  );

  const interval = isControlled ? controlledInterval : internalInterval;

  useEffect(() => {
    if (isControlled) return;
    if (!isChartTimeframeAllowed(internalInterval, allowedTimeframes)) {
      setInternalInterval(defaultApiInterval(allowedTimeframes));
    }
  }, [allowedTimeframes, internalInterval, isControlled]);

  const loadCandles = useCallback(
    nextInterval => {
      if (!isChartTimeframeAllowed(nextInterval, allowedTimeframes)) return;
      if (isControlled) {
        onIntervalChange?.(nextInterval);
      } else {
        setInternalInterval(nextInterval);
      }
    },
    [allowedTimeframes, isControlled, onIntervalChange]
  );

  const { candles, provider, loading, error, liveStatus } = useMarketCandles({
    symbol: debouncedSymbol,
    interval,
    limit: 200,
    subscribed,
    liveEnabled
  });

  const { liveSignal, stage, analyzing, closedOutcome } = useLiveChartLevels({
    symbol: debouncedSymbol,
    interval,
    candles,
    subscribed: subscribed && useLiveLevels,
    isAuthenticated
  });

  const overlaySignal = useLiveLevels ? liveSignal : null;

  if (!subscribed) {
    return <div className="empty-state">Subscribe to view live Kaching charts.</div>;
  }

  return (
    <div className="market-chart-panel">
      <ChartTimeframeToolbar
        symbol={symbol}
        allowedSymbols={allowedSymbols}
        onSymbolChange={onSymbolChange}
        activeInterval={interval}
        allowedTimeframes={allowedTimeframes}
        onTimeframeChange={loadCandles}
        loading={loading}
      />

      {loading && candles.length === 0 && <div className="loading-state">Loading chart data…</div>}
      {error && candles.length === 0 && <div className="feature-lock">{error}</div>}
      {liveStatus === 'stale' && candles.length > 0 && (
        <div className="page-notice info-box">
          Live refresh delayed — showing cached candles while the data provider catches up.
        </div>
      )}
      {useLiveLevels && analyzing && candles.length > 0 && (
        <div className="page-notice info-box">Scanning live candles for Entry / SL / TP…</div>
      )}
      {useLiveLevels && !analyzing && stage === 'pending_retrace' && !liveSignal && (
        <div className="page-notice info-box">Setup forming — waiting for retrace entry on live candles.</div>
      )}
      {useLiveLevels && stage === 'active_trade' && liveSignal && (
        <div className="page-notice info-box">Active trade levels — staying on chart until SL or TP is hit.</div>
      )}
      {useLiveLevels && closedOutcome && (
        <div className="page-notice info-box">Trade closed at {closedOutcome.toUpperCase()} — levels cleared.</div>
      )}
      <KachingLightweightChart
        candles={candles}
        overlaySignal={overlaySignal}
        symbol={debouncedSymbol}
        interval={interval}
        liveEnabled={liveEnabled}
        liveStatus={liveStatus}
        provider={provider}
        height={height}
      />
      {!loading && !error && candles.length === 0 && (
        <div className="empty-state">No candle data available for {debouncedSymbol}.</div>
      )}
    </div>
  );
}
