import { useCallback, useEffect, useMemo, useState } from 'react';
import { marketDataApi } from '../../services/api';
import { findLatestEntrySignal } from '../../utils/chartLevels';
import KachingLightweightChart from './KachingLightweightChart';

export default function MarketChartPanel({
  symbol,
  interval,
  overlaySignals = [],
  subscribed = true,
  liveEnabled = true,
  height = 420
}) {
  const [candles, setCandles] = useState([]);
  const [provider, setProvider] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const overlaySignal = useMemo(
    () => findLatestEntrySignal(overlaySignals, symbol),
    [overlaySignals, symbol]
  );

  const loadCandles = useCallback(async () => {
    if (!subscribed || !symbol) return;
    setLoading(true);
    setError('');
    try {
      const response = await marketDataApi.getCandles(symbol, { interval, limit: 200 });
      setCandles(response.data.candles || []);
      setProvider(response.data.provider || null);
    } catch (err) {
      setCandles([]);
      setProvider(null);
      const data = err.response?.data;
      const apiMessage =
        (typeof data === 'object' && (data?.message || data?.detail)) ||
        (typeof data === 'string' && data.includes('Cannot GET') ? 'Chart API not found — restart the backend server.' : null) ||
        err.message;
      setError(apiMessage || 'Failed to load chart data.');
    } finally {
      setLoading(false);
    }
  }, [subscribed, symbol, interval]);

  useEffect(() => {
    loadCandles();
  }, [loadCandles]);

  if (!subscribed) {
    return <div className="empty-state">Subscribe to view live Kaching charts.</div>;
  }

  return (
    <div className="market-chart-panel">
      {loading && candles.length === 0 && <div className="loading-state">Loading chart data…</div>}
      {error && <div className="feature-lock">{error}</div>}
      {candles.length > 0 && (
        <KachingLightweightChart
          candles={candles}
          overlaySignal={overlaySignal}
          symbol={symbol}
          interval={interval}
          liveEnabled={liveEnabled}
          provider={provider}
          height={height}
        />
      )}
      {!loading && !error && candles.length === 0 && (
        <div className="empty-state">No candle data available for {symbol}.</div>
      )}
    </div>
  );
}
