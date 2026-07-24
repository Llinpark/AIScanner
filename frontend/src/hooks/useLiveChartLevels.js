import { useEffect, useMemo, useRef, useState } from 'react';
import { getSharedSocket } from '../services/marketDataSocket';
import { normalizeInterval, symbolsMatch } from '../utils/chartLevels';
import { attachActivation, detectTradeOutcome } from '../utils/tradeLevelLifecycle';

/**
 * Chart overlays come from TradingView webhook signals (props + socket), never from
 * live-provider recalculation /scanner/analyze.
 */
export default function useLiveChartLevels({
  symbol,
  interval = '1h',
  candles = [],
  overlaySignals = [],
  subscribed = true,
  isAuthenticated = false
}) {
  const [liveSignal, setLiveSignal] = useState(null);
  const [stage, setStage] = useState(null);
  const [closedOutcome, setClosedOutcome] = useState(null);
  const liveSignalRef = useRef(null);

  useEffect(() => {
    liveSignalRef.current = liveSignal;
  }, [liveSignal]);

  const matchingOverlay = useMemo(() => {
    if (!symbol || !overlaySignals?.length) return null;
    const normalizedInterval = normalizeInterval(interval);
    const open = overlaySignals.find(s => {
      if (!symbolsMatch(s.symbol, symbol)) return false;
      const alertType = s.alertType || 'signal';
      if (alertType !== 'entry' && alertType !== 'signal') return false;
      if (s.outcome && s.outcome !== 'pending') return false;
      if (s.tradeStatus && !['open', 'partial'].includes(s.tradeStatus)) return false;
      if (s.timeframe && normalizeInterval(s.timeframe) !== normalizedInterval) {
        // Allow overlay when timeframe missing on legacy signals.
        return false;
      }
      return s.entry != null && (s.stop_loss != null || s.stop_loss_1 != null);
    });
    return open || null;
  }, [overlaySignals, symbol, interval]);

  useEffect(() => {
    setClosedOutcome(null);
    if (!subscribed || !matchingOverlay) {
      setLiveSignal(null);
      setStage(null);
      return;
    }
    setLiveSignal(
      matchingOverlay.activatedAtBarTime
        ? matchingOverlay
        : attachActivation(matchingOverlay, Date.now())
    );
    setStage(matchingOverlay.tradeStatus === 'open' || !matchingOverlay.outcome ? 'active_trade' : 'entry');
  }, [subscribed, matchingOverlay, symbol, interval]);

  useEffect(() => {
    if (!subscribed || !symbol || !candles.length || !liveSignalRef.current) return undefined;

    const hit = detectTradeOutcome(liveSignalRef.current, candles);
    if (!hit) return undefined;

    setLiveSignal(null);
    setStage('closed');
    setClosedOutcome(hit.outcome);
    return undefined;
  }, [subscribed, symbol, candles]);

  useEffect(() => {
    if (!subscribed || !isAuthenticated || !symbol) return undefined;

    const socket = getSharedSocket();
    if (!socket) return undefined;

    const handleSignalUpdate = payload => {
      if (!payload || !symbolsMatch(payload.symbol, symbol)) return;
      const alertType = payload.alertType || 'signal';
      if (alertType !== 'entry' && alertType !== 'signal') return;
      setClosedOutcome(null);
      setStage('entry');
      setLiveSignal(attachActivation(payload, payload.activatedAtBarTime || Date.now()));
    };

    const handleOutcome = payload => {
      if (!payload || !symbolsMatch(payload.symbol, symbol)) return;
      if (payload.outcome && payload.outcome !== 'pending') {
        setLiveSignal(null);
        setStage('closed');
        setClosedOutcome(payload.outcome);
      }
    };

    socket.on('signal:update', handleSignalUpdate);
    socket.on('signal:outcome', handleOutcome);
    socket.on('tv:live-alert', handleSignalUpdate);

    return () => {
      socket.off('signal:update', handleSignalUpdate);
      socket.off('signal:outcome', handleOutcome);
      socket.off('tv:live-alert', handleSignalUpdate);
    };
  }, [subscribed, isAuthenticated, symbol]);

  useEffect(() => {
    if (!closedOutcome) return undefined;
    const timer = setTimeout(() => setClosedOutcome(null), 6000);
    return () => clearTimeout(timer);
  }, [closedOutcome]);

  return { liveSignal, stage, analyzing: false, closedOutcome };
}
