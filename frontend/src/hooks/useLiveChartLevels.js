import { useEffect, useRef, useState } from 'react';
import { getSharedSocket } from '../services/marketDataSocket';
import { scannerApi } from '../services/api';
import { normalizeInterval, symbolsMatch } from '../utils/chartLevels';
import { attachActivation, detectTradeOutcome } from '../utils/tradeLevelLifecycle';

const ANALYZE_DEBOUNCE_MS = 350;

function candleBarKey(candles) {
  if (!candles?.length) return '';
  const last = candles[candles.length - 1];
  const ts = last.timestamp || last.time || '';
  return `${ts}:${candles.length}:${last.close}`;
}

function latestBarTime(candles) {
  if (!candles?.length) return Date.now();
  const last = candles[candles.length - 1];
  const raw = last.timestamp || last.time;
  const parsed = Number(raw);
  if (Number.isFinite(parsed)) return parsed > 1e12 ? parsed : parsed * 1000;
  const dateParsed = Date.parse(raw);
  return Number.isFinite(dateParsed) ? dateParsed : Date.now();
}

export default function useLiveChartLevels({
  symbol,
  interval = '1h',
  candles = [],
  subscribed = true,
  isAuthenticated = false
}) {
  const [liveSignal, setLiveSignal] = useState(null);
  const [stage, setStage] = useState(null);
  const [closedOutcome, setClosedOutcome] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const lastBarRef = useRef('');
  const requestIdRef = useRef(0);
  const liveSignalRef = useRef(null);

  useEffect(() => {
    liveSignalRef.current = liveSignal;
  }, [liveSignal]);

  useEffect(() => {
    setLiveSignal(null);
    setStage(null);
    setClosedOutcome(null);
    lastBarRef.current = '';
  }, [symbol, interval]);

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
    if (!subscribed || !symbol || !candles.length) {
      return undefined;
    }

    const barKey = candleBarKey(candles);
    if (barKey === lastBarRef.current) {
      return undefined;
    }
    lastBarRef.current = barKey;

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setAnalyzing(true);

    const timer = setTimeout(() => {
      scannerApi
        .analyze(symbol, { interval: normalizeInterval(interval) })
        .then(response => {
          if (requestIdRef.current !== requestId) return;
          const data = response.data || {};
          setStage(data.stage || null);

          if (data.stage === 'closed') {
            setLiveSignal(null);
            setClosedOutcome(data.outcome || data.closedLevel?.outcome || null);
            return;
          }

          if (data.entry) {
            setClosedOutcome(null);
            setLiveSignal(
              data.entry.activatedAtBarTime
                ? data.entry
                : attachActivation(data.entry, latestBarTime(candles))
            );
            return;
          }

          if (data.stage !== 'active_trade') {
            const hit = detectTradeOutcome(liveSignalRef.current, candles);
            if (hit) {
              setLiveSignal(null);
              setStage('closed');
              setClosedOutcome(hit.outcome);
            }
          }
        })
        .catch(() => {
          if (requestIdRef.current !== requestId) return;
        })
        .finally(() => {
          if (requestIdRef.current === requestId) {
            setAnalyzing(false);
          }
        });
    }, ANALYZE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [subscribed, symbol, interval, candles]);

  useEffect(() => {
    if (!subscribed || !isAuthenticated || !symbol) return undefined;

    const socket = getSharedSocket();
    if (!socket) return undefined;

    const handleScannerEntry = payload => {
      if (!payload || !symbolsMatch(payload.symbol, symbol)) return;
      setClosedOutcome(null);
      setStage('entry');
      setLiveSignal(
        attachActivation(payload, payload.activatedAtBarTime || latestBarTime(candles))
      );
    };

    socket.on('scanner:entry', handleScannerEntry);

    return () => {
      socket.off('scanner:entry', handleScannerEntry);
    };
  }, [subscribed, isAuthenticated, symbol, candles]);

  useEffect(() => {
    if (!closedOutcome) return undefined;
    const timer = setTimeout(() => setClosedOutcome(null), 6000);
    return () => clearTimeout(timer);
  }, [closedOutcome]);

  return { liveSignal, stage, analyzing, closedOutcome };
}
