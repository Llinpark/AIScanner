import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { marketDataApi } from '../services/api';
import { getSharedSocket } from '../services/marketDataSocket';
import { normalizeInterval, symbolsMatch } from '../utils/chartLevels';

const inflightRequests = new Map();
const lastPayloadByStream = new Map();
const LOAD_TIMEOUT_MS = 30000;
const HTTP_TIMEOUT_MS = 25000;
const CLIENT_CACHE_REUSE_MS = 120_000;

function fetchCachedCandles(symbol, interval, limit) {
  const key = `${symbol}:${interval}:${limit}`;
  if (inflightRequests.has(key)) {
    return inflightRequests.get(key);
  }

  const request = marketDataApi
    .getCandles(symbol, { interval, limit, timeout: HTTP_TIMEOUT_MS })
    .finally(() => {
      inflightRequests.delete(key);
    });

  inflightRequests.set(key, request);
  return request;
}

function isRecentClientCache(payload) {
  if (!payload?.candles?.length || !payload.cachedAt) return false;
  return Date.now() - Date.parse(payload.cachedAt) < CLIENT_CACHE_REUSE_MS;
}

function applyCandlePayload(setters, payload, streamKey) {
  if (!payload) return;
  const rows = payload.candles || [];
  lastPayloadByStream.set(streamKey, payload);
  setters.setCandles(rows);
  setters.setProvider(payload.provider || null);
  setters.setFallbackUsed(Boolean(payload.fallback_used));
  setters.setFallbackInterval(payload.fallback_interval || null);
  setters.setLoading(false);
  if (payload.refreshError) {
    setters.setError('');
    setters.setLiveStatus('stale');
    return;
  }
  setters.setError('');
  setters.setLiveStatus(payload.stale ? 'stale' : 'synced');
}

export default function useMarketCandles({
  symbol,
  interval = '1h',
  limit = 200,
  subscribed = true,
  liveEnabled = true
}) {
  const { isAuthenticated } = useAuth();
  const [candles, setCandles] = useState([]);
  const [provider, setProvider] = useState(null);
  const [fallbackUsed, setFallbackUsed] = useState(false);
  const [fallbackInterval, setFallbackInterval] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [liveStatus, setLiveStatus] = useState('idle');
  const activeStreamRef = useRef('');

  useEffect(() => {
    if (!subscribed || !symbol || !interval) {
      setCandles([]);
      setProvider(null);
      setFallbackUsed(false);
      setFallbackInterval(null);
      setError('');
      setLiveStatus('off');
      activeStreamRef.current = '';
      return undefined;
    }

    const canonicalInterval = normalizeInterval(interval);
    const streamKey = `${symbol}:${canonicalInterval}`;
    activeStreamRef.current = streamKey;
    let cancelled = false;
    let resolved = false;
    let timeoutId;

    const cachedPayload = lastPayloadByStream.get(streamKey);
    if (cachedPayload?.candles?.length) {
      setCandles(cachedPayload.candles);
      setProvider(cachedPayload.provider || null);
      setFallbackUsed(Boolean(cachedPayload.fallback_used));
      setFallbackInterval(cachedPayload.fallback_interval || null);
      setLoading(false);
      setError('');
      setLiveStatus(cachedPayload.stale ? 'stale' : 'synced');
    } else {
      setLoading(true);
      setError('');
    }

    const setters = {
      setCandles,
      setProvider,
      setFallbackUsed,
      setFallbackInterval,
      setLoading,
      setError,
      setLiveStatus
    };

    const markResolved = () => {
      resolved = true;
      clearTimeout(timeoutId);
    };

    timeoutId = setTimeout(() => {
      if (cancelled || resolved || activeStreamRef.current !== streamKey) return;
      if (lastPayloadByStream.get(streamKey)?.candles?.length) {
        setLoading(false);
        setLiveStatus('stale');
        return;
      }
      setLoading(false);
      setError('Chart data timed out. Check backend connection and refresh.');
      setLiveStatus('error');
    }, LOAD_TIMEOUT_MS);

    const skipHttp = isRecentClientCache(cachedPayload);
    if (!skipHttp) {
      fetchCachedCandles(symbol, canonicalInterval, limit)
        .then(response => {
          if (cancelled || activeStreamRef.current !== streamKey) return;
          markResolved();
          applyCandlePayload(setters, response.data, streamKey);
          if (!liveEnabled) {
            setLiveStatus('off');
          }
        })
        .catch(err => {
          if (cancelled || activeStreamRef.current !== streamKey) return;
          markResolved();
          if (lastPayloadByStream.get(streamKey)?.candles?.length) {
            setLoading(false);
            setError('');
            setLiveStatus('stale');
            return;
          }
          const data = err.response?.data;
          const message =
            (typeof data === 'object' && (data?.message || data?.detail)) ||
            (err.code === 'ECONNABORTED' ? 'Chart request timed out. Try refreshing.' : null) ||
            err.message ||
            'Failed to load chart data.';
          setError(message);
          setLoading(false);
          setLiveStatus('error');
        });
    } else {
      markResolved();
    }

    if (!liveEnabled || !isAuthenticated) {
      return () => {
        cancelled = true;
        clearTimeout(timeoutId);
      };
    }

    const socket = getSharedSocket();
    if (!socket) {
      return () => {
        cancelled = true;
        clearTimeout(timeoutId);
      };
    }

    const subscribe = () => {
      if (cancelled || activeStreamRef.current !== streamKey) return;
      socket.emit('market:subscribe', { symbol, interval: canonicalInterval, limit });
      setLiveStatus(prev => (prev === 'synced' || prev === 'stale' ? prev : 'connected'));
    };

    const handleMarketCandles = payload => {
      if (!payload || activeStreamRef.current !== streamKey) return;
      if (!symbolsMatch(payload.symbol, symbol)) return;
      if (payload.interval && normalizeInterval(payload.interval) !== canonicalInterval) return;
      markResolved();
      applyCandlePayload(setters, payload, streamKey);
    };

    const handleMarketError = payload => {
      if (activeStreamRef.current !== streamKey || !payload?.message) return;
      if (lastPayloadByStream.get(streamKey)?.candles?.length) {
        setError('');
        setLiveStatus('stale');
        return;
      }
      markResolved();
      setError(payload.message);
      setLoading(false);
      setLiveStatus('error');
    };

    const handleDisconnect = () => {
      if (activeStreamRef.current === streamKey) {
        setLiveStatus('disconnected');
      }
    };

    const handleConnectError = () => {
      if (activeStreamRef.current === streamKey && !lastPayloadByStream.get(streamKey)?.candles?.length) {
        setLiveStatus('error');
      }
    };

    socket.on('market:candles', handleMarketCandles);
    socket.on('market:error', handleMarketError);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);

    if (socket.connected) {
      subscribe();
    } else {
      socket.once('connect', subscribe);
    }

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      socket.emit('market:unsubscribe', { symbol, interval: canonicalInterval });
      socket.off('connect', subscribe);
      socket.off('market:candles', handleMarketCandles);
      socket.off('market:error', handleMarketError);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
    };
  }, [subscribed, symbol, interval, limit, liveEnabled, isAuthenticated]);

  return {
    candles,
    provider,
    fallbackUsed,
    fallbackInterval,
    loading,
    error,
    liveStatus
  };
}
