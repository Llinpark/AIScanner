import { useEffect, useMemo, useRef, useState } from 'react';
import { getSharedSocket } from '../services/marketDataSocket';
import { normalizeInterval, symbolsMatch } from '../utils/chartLevels';
import {
  attachActivation,
  detectTradeClose,
  detectTradeOutcome,
  isTerminalOutcome
} from '../utils/tradeLevelLifecycle';

/**
 * Chart overlays come from TradingView webhook signals (props + socket), never from
 * live-provider recalculation /scanner/analyze.
 * Overlays stay until TP3 / SL / expired / cancelled — never clear on TP1/TP2 alone.
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
    const matchingSignals = overlaySignals.filter(s => {
      if (!symbolsMatch(s.symbol, symbol)) return false;
      const alertType = s.alertType || 'signal';
      if (alertType !== 'entry' && alertType !== 'signal') return false;
      if (s.timeframe && normalizeInterval(s.timeframe) !== normalizedInterval) {
        // Allow overlay when timeframe missing on legacy signals.
        return false;
      }
      return s.entry != null && (s.stop_loss != null || s.stop_loss_1 != null);
    });
    if (!matchingSignals.length) return null;

    const open = matchingSignals.find(s => {
      if (isTerminalOutcome(s.outcome)) return false;
      if (s.tradeStatus && !['open', 'partial'].includes(s.tradeStatus)) return false;
      return true;
    });
    if (open) return open;

    return [...matchingSignals].sort((left, right) => {
      const leftTime = Date.parse(left.createdAt || left.updatedAt || 0) || 0;
      const rightTime = Date.parse(right.createdAt || right.updatedAt || 0) || 0;
      return rightTime - leftTime;
    })[0] || null;
  }, [overlaySignals, symbol, interval]);

  const historicalSignals = useMemo(() => {
    if (!symbol || !overlaySignals?.length) return [];
    const normalizedInterval = normalizeInterval(interval);
    const primaryId = matchingOverlay
      ? String(
          matchingOverlay.signalUuid ||
            matchingOverlay._id ||
            matchingOverlay.id ||
            matchingOverlay.signalId ||
            ''
        )
      : '';

    return overlaySignals
      .filter(s => {
        if (!symbolsMatch(s.symbol, symbol)) return false;
        const alertType = s.alertType || 'signal';
        if (alertType !== 'entry' && alertType !== 'signal') return false;
        if (s.timeframe && normalizeInterval(s.timeframe) !== normalizedInterval) return false;
        if (s.entry == null || (s.stop_loss == null && s.stop_loss_1 == null)) return false;
        const id = String(s.signalUuid || s._id || s.id || s.signalId || '');
        if (primaryId && id && id === primaryId) return false;
        return true;
      })
      .sort((left, right) => {
        const leftTime = Date.parse(left.createdAt || left.updatedAt || 0) || 0;
        const rightTime = Date.parse(right.createdAt || right.updatedAt || 0) || 0;
        return rightTime - leftTime;
      })
      .slice(0, 40);
  }, [overlaySignals, symbol, interval, matchingOverlay]);

  useEffect(() => {
    setClosedOutcome(null);
    if (!subscribed || !matchingOverlay) {
      setLiveSignal(null);
      setStage(null);
      return;
    }
    if (isTerminalOutcome(matchingOverlay.outcome)) {
      setLiveSignal(null);
      setStage('closed');
      setClosedOutcome(matchingOverlay.outcome);
      return;
    }
    setLiveSignal(
      matchingOverlay.activatedAtBarTime
        ? matchingOverlay
        : attachActivation(matchingOverlay, Date.now())
    );
    const stageFromOutcome =
      matchingOverlay.outcome === 'tp2'
        ? 'tp2'
        : matchingOverlay.outcome === 'tp1'
          ? 'tp1'
          : matchingOverlay.tradeStatus === 'open' || !matchingOverlay.outcome
            ? 'active_trade'
            : 'entry';
    setStage(stageFromOutcome);
  }, [subscribed, matchingOverlay, symbol, interval]);

  useEffect(() => {
    if (!subscribed || !symbol || !candles.length || !liveSignalRef.current) return undefined;

    const closeHit = detectTradeClose(liveSignalRef.current, candles);
    if (closeHit) {
      setLiveSignal(null);
      setStage('closed');
      setClosedOutcome(closeHit.outcome);
      return undefined;
    }

    const partial = detectTradeOutcome(liveSignalRef.current, candles);
    if (partial && !partial.terminal) {
      setLiveSignal(prev =>
        prev
          ? {
              ...prev,
              outcome: partial.outcome,
              outcomeR: partial.outcomeR,
              tradeStatus: 'partial',
              lifecycleStage: partial.outcome === 'tp2' ? 'TP2' : 'TP1'
            }
          : prev
      );
      setStage(partial.outcome);
    }
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
      if (!payload.outcome || payload.outcome === 'pending') return;

      if (isTerminalOutcome(payload.outcome)) {
        setLiveSignal(null);
        setStage('closed');
        setClosedOutcome(payload.outcome);
        return;
      }

      // TP1 / TP2 — keep overlay, advance stage only.
      setLiveSignal(prev =>
        prev
          ? {
              ...prev,
              outcome: payload.outcome,
              outcomeR: payload.outcomeR,
              tradeStatus: payload.tradeStatus || 'partial',
              lifecycleStage: payload.lifecycleStage
            }
          : prev
      );
      setStage(payload.outcome);
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

  return { liveSignal, stage, analyzing: false, closedOutcome, historicalSignals };
}
