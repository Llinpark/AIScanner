import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { io } from 'socket.io-client';
import { tradingviewApi, subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import TelegramSetup from './TelegramSetup';
import MarketChartPanel from './charts/MarketChartPanel';
import { alertMatchesSymbol, normalizeMarketSymbol } from '../constants/markets';

import { SOCKET_URL } from '../config/appUrls';

const ALERT_LABELS = {
  entry: 'Kaching Entry',
  stop_loss: 'Kaching SL',
  take_profit_1: 'Kaching TP1',
  take_profit_2: 'Kaching TP2',
  take_profit_3: 'Kaching TP3',
  signal: 'Kaching Signal'
};

function hasLiveAccess(subscription) {
  if (!subscription) return false;
  return subscription.status === 'active';
}

function AlertCard({ alert, showConfidence }) {
  const type = alert.alertType || 'signal';
  return (
    <div className={`alert-card alert-${alert.direction} alert-type-${type}`}>
      <div className="alert-header">
        <span className={`alert-type-badge type-${type}`}>{ALERT_LABELS[type] || type}</span>
        <span className={`direction-badge ${alert.direction}`}>{alert.direction.toUpperCase()}</span>
        <span className="time">{new Date(alert.createdAt).toLocaleString()}</span>
      </div>
      <div className="alert-details">
        <DetailRow label="Symbol" value={alert.symbol} />
        <DetailRow label="Kaching Entry" value={Number(alert.entry).toFixed(5)} />
        <DetailRow label="Kaching SL" value={Number(alert.stop_loss_1 ?? alert.stop_loss).toFixed(5)} />
        <DetailRow label="Kaching TP1" value={Number(alert.take_profit_1).toFixed(5)} />
        <DetailRow label="Kaching TP2" value={Number(alert.take_profit_2).toFixed(5)} />
        <DetailRow label="Kaching TP3" value={Number(alert.take_profit_3).toFixed(5)} />
        {showConfidence && alert.confidence > 0 && (
          <DetailRow label="Confidence" value={`${(alert.confidence * 100).toFixed(0)}%`} />
        )}
      </div>
      {(alert.message || alert.notes) && <p className="notes">{alert.message || alert.notes}</p>}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function TradingViewDashboard({ subscription, onNavigatePricing, initialTab }) {
  const { token } = useAuth();
  const [setup, setSetup] = useState(null);
  const [liveFilter, setLiveFilter] = useState('ALL');
  const [chartSymbol, setChartSymbol] = useState('EUR/USD');
  const [historySymbol, setHistorySymbol] = useState('EUR/USD');
  const [historicalData, setHistoricalData] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [liveAlerts, setLiveAlerts] = useState([]);
  const [indicators, setIndicators] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState(initialTab || 'live');

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);
  const [pineMeta, setPineMeta] = useState(null);
  const [pineCopyState, setPineCopyState] = useState('idle');
  const [pineLoadError, setPineLoadError] = useState('');
  const pineScriptRef = useRef('');
  const [socketStatus, setSocketStatus] = useState('disconnected');

  const [tierLimits, setTierLimits] = useState({
    showConfidence: false,
    currencyPairs: ['EUR/USD', 'GBP/USD'],
    timeframes: ['1h'],
    historyDays: 7
  });
  const [selectedTimeframe, setSelectedTimeframe] = useState('1h');
  const [historyError, setHistoryError] = useState('');

  const symbols = tierLimits.currencyPairs || ['EUR/USD', 'GBP/USD'];
  const timeframes = tierLimits.timeframes || ['1h'];
  const subscribed = hasLiveAccess(subscription);

  useEffect(() => {
    if (symbols.length && !symbols.includes(historySymbol)) {
      setHistorySymbol(symbols[0]);
    }
    if (symbols.length && !symbols.includes(chartSymbol)) {
      setChartSymbol(symbols[0]);
    }
  }, [symbols, historySymbol, chartSymbol]);

  useEffect(() => {
    if (!subscribed) return;
    subscriptionApi
      .getMe()
      .then(res => {
        if (res.data.tierFeatures) {
          setTierLimits(res.data.tierFeatures);
          const pairs = res.data.allowedCurrencyPairs || res.data.tierFeatures.currencyPairs || ['EUR/USD'];
          const frames = res.data.tierFeatures.timeframes || ['1h'];
          if (!pairs.includes(historySymbol)) setHistorySymbol(pairs[0]);
          if (!frames.includes(selectedTimeframe)) setSelectedTimeframe(frames[0]);
        }
      })
      .catch(() => {});
  }, [subscribed, subscription]);

  const fetchSetup = useCallback(async () => {
    try {
      const response = await tradingviewApi.getSetup();
      setSetup(response.data);
    } catch (error) {
      console.error('Failed to fetch TradingView setup:', error);
    }
  }, []);

  const loadPineScriptBundle = useCallback(async () => {
    const response = await tradingviewApi.getPineScript();
    pineScriptRef.current = response.data.script || '';
    setPineMeta({
      webhookUrl: response.data.webhookUrl,
      scriptId: response.data.scriptId,
      tierLabel: response.data.tierLabel,
      subscriberLabel: response.data.subscriberLabel,
      generatedAt: response.data.generatedAt,
      security: response.data.security,
      instructions: response.data.instructions || []
    });
    return pineScriptRef.current;
  }, []);

  const loadPineMeta = useCallback(async () => {
    setPineLoadError('');
    try {
      await loadPineScriptBundle();
    } catch (error) {
      console.error('Failed to load Pine Script:', error);
      setPineLoadError(error.response?.data?.message || 'Unable to load your Pine Script. Try again or refresh the page.');
    }
  }, [loadPineScriptBundle]);

  const fetchAlerts = useCallback(async () => {
    try {
      setLoading(true);
      const response = await tradingviewApi.getAlerts(liveFilter === 'ALL' ? null : liveFilter);
      setAlerts(response.data.alerts);
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
    } finally {
      setLoading(false);
    }
  }, [liveFilter]);

  useEffect(() => {
    if (subscribed) {
      fetchSetup();
    }
  }, [subscribed, fetchSetup]);

  useEffect(() => {
    if (subscribed && activeTab === 'setup' && !pineScriptRef.current) {
      loadPineMeta();
    }
  }, [subscribed, activeTab, loadPineMeta]);

  useEffect(() => {
    if (subscribed) {
      fetchAlerts();
    }
  }, [subscribed, fetchAlerts]);

  useEffect(() => {
    if (!token || !subscribed) return undefined;

    const socket = io(SOCKET_URL, { auth: { token } });

    socket.on('subscriber:ready', () => setSocketStatus('connected'));
    socket.on('connect', () => setSocketStatus('connected'));
    socket.on('disconnect', () => setSocketStatus('disconnected'));
    socket.on('connect_error', () => setSocketStatus('error'));

    socket.on('tv:live-alert', alert => {
      setLiveAlerts(prev => [alert, ...prev].slice(0, 100));
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('KachingFx Live Alert', { body: alert.message });
      }
    });

    return () => socket.disconnect();
  }, [token, subscribed]);

  const fetchHistoricalData = async () => {
    try {
      setLoading(true);
      setHistoryError('');
      const response = await tradingviewApi.getHistory(historySymbol, { interval: selectedTimeframe });
      setHistoricalData(response.data.data);
      setIndicators(response.data.indicators || null);
    } catch (error) {
      setHistoryError(error.response?.data?.message || 'Failed to fetch historical data.');
      setHistoricalData([]);
      setIndicators(null);
    } finally {
      setLoading(false);
    }
  };

  const copyPineScript = async () => {
    setPineCopyState('loading');
    try {
      if (!pineScriptRef.current) {
        await loadPineScriptBundle();
      }
      if (!pineScriptRef.current) {
        throw new Error('Script unavailable');
      }
      await navigator.clipboard.writeText(pineScriptRef.current);
      setPineCopyState('success');
      window.setTimeout(() => setPineCopyState('idle'), 3000);
    } catch (error) {
      console.error('Failed to copy Pine Script:', error);
      setPineCopyState('error');
      window.setTimeout(() => setPineCopyState('idle'), 4000);
    }
  };

  const displayAlerts = useMemo(() => {
    const source = liveAlerts.length ? liveAlerts : alerts;
    const allowed = new Set(symbols.map(normalizeMarketSymbol));

    return source.filter(alert => {
      const normalized = normalizeMarketSymbol(alert.symbol);
      if (!allowed.has(normalized)) return false;
      return alertMatchesSymbol(alert, liveFilter);
    });
  }, [liveAlerts, alerts, liveFilter, symbols]);

  return (
    <div className="tv-dashboard">
      <div className="tv-header">
        <h2>TradingView Alert Setup</h2>
        <p>
          After subscribing, open TradingView to receive accurate Kaching Entry, Kaching SL, Kaching TP1, Kaching TP2, and Kaching TP3 alerts.
          No TradingView username linking is required.
        </p>
      </div>

      {!subscribed && (
        <div className="subscription-banner">
          <p>
            Subscribe to unlock live alerts and the TradingView setup guide.{' '}
            <button type="button" className="btn-link-inline" onClick={onNavigatePricing}>
              View pricing
            </button>
          </p>
        </div>
      )}

      {subscribed && setup && (
        <div className="setup-instructions">
          <h3>Getting started</h3>
          <ol>
            {setup.instructions.map((step, idx) => (
              <li key={idx}>{step}</li>
            ))}
          </ol>
          <p className="setup-status">
            Live feed: {socketStatus === 'connected' ? 'Connected' : 'Connecting…'}
          </p>
        </div>
      )}

      <div className="tv-tabs">
        <button type="button" className={`tab-btn ${activeTab === 'live' ? 'active' : ''}`} onClick={() => setActiveTab('live')}>
          Live Alerts
        </button>
        <button type="button" className={`tab-btn ${activeTab === 'setup' ? 'active' : ''}`} onClick={() => setActiveTab('setup')}>
          TradingView Setup
        </button>
        <button type="button" className={`tab-btn ${activeTab === 'telegram' ? 'active' : ''}`} onClick={() => setActiveTab('telegram')}>
          Trade Copier
        </button>
        <button type="button" className={`tab-btn ${activeTab === 'chart' ? 'active' : ''}`} onClick={() => setActiveTab('chart')}>
          Chart
        </button>
        <button type="button" className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>
          History
        </button>
      </div>

      {activeTab === 'live' && (
        <div className="tv-section">
          {!subscribed ? (
            <div className="empty-state">Subscribe to receive live Kaching Entry, Kaching SL, Kaching TP1, Kaching TP2, and Kaching TP3 alerts.</div>
          ) : (
            <>
              <div className="live-controls">
                <select value={liveFilter} onChange={e => setLiveFilter(e.target.value)}>
                  <option value="ALL">All symbols</option>
                  {symbols.map(symbol => (
                    <option key={symbol} value={symbol}>
                      {symbol}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn-fetch" onClick={fetchAlerts} disabled={loading}>
                  Refresh
                </button>
              {tierLimits.telegramAlerts && (
                <button type="button" className="btn-toggle" onClick={() => setActiveTab('telegram')}>
                  Set up Telegram bot alerts
                </button>
              )}
              </div>

              {displayAlerts.length === 0 ? (
                <div className="empty-state">
                  Waiting for live alerts. Set up TradingView using the Setup tab, or wait for the next broadcast signal.
                </div>
              ) : (
                <div className="alerts-list">
                  {displayAlerts.map((alert, idx) => (
                    <AlertCard
                      key={alert.id || alert._id || idx}
                      alert={alert}
                      showConfidence={tierLimits.showConfidence}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === 'setup' && (
        <div className="tv-section">
          {!subscribed ? (
            <div className="empty-state">Subscribe first to access the TradingView Pine Script and setup guide.</div>
          ) : (
            <div className="pine-script-section">
              <h3>Open TradingView for accurate alerts</h3>
              <p>
                Add the KachingFx indicator to your chart in TradingView. Create alerts for{' '}
                <strong>Kaching Entry</strong>, <strong>Kaching SL</strong>, <strong>Kaching TP1</strong>,{' '}
                <strong>Kaching TP2</strong>, and <strong>Kaching TP3</strong>.
                Enable TradingView push or email notifications so alerts reach you instantly.
              </p>
              {tierLimits.multiMarketScanner && (
                <p className="premium-feature-hint">Multi-market scanner enabled on your Premium plan.</p>
              )}
              {tierLimits.smartMoneyConcepts && (
                <p className="premium-feature-hint">Smart Money Concepts overlays included.</p>
              )}
              {tierLimits.mt5Execution && (
                <p className="premium-feature-hint">
                  Telegram Trade Copier is enabled — tap Execute on MT5 alerts to auto-fill entry, SL, TP, and lot size.
                </p>
              )}
              {tierLimits.trailingStop && (
                <p className="premium-feature-hint">Trailing stop automation is included.</p>
              )}
              {tierLimits.breakEvenAutomation && (
                <p className="premium-feature-hint">Break-even automation is active for Premium trades.</p>
              )}
              {tierLimits.autoLotSizing && (
                <p className="premium-feature-hint">Auto lot sizing adjusts position size from your MT5 account balance.</p>
              )}

              <div className="pine-script-box">
                {pineMeta && (
                  <div className="pine-script-meta">
                    <p>
                      <strong>Generated for:</strong> {pineMeta.subscriberLabel} ({pineMeta.tierLabel})
                    </p>
                    <p>
                      <strong>Webhook URL:</strong> <code>{pineMeta.webhookUrl}</code>
                    </p>
                    <p>
                      <strong>Script ID:</strong> {pineMeta.scriptId}
                      {pineMeta.generatedAt && (
                        <span> · {new Date(pineMeta.generatedAt).toLocaleString()}</span>
                      )}
                    </p>
                    {pineMeta.security && (
                      <p>
                        <strong>Security:</strong> Each alert includes your personal{' '}
                        <code>licenseToken</code>. API clients may also send{' '}
                        <code>{pineMeta.security.signatureHeader}</code> ({pineMeta.security.signatureFormat}).
                      </p>
                    )}
                  </div>
                )}

                <div className="pine-script-instructions">
                  <ol>
                    {(pineMeta?.instructions?.length
                      ? pineMeta.instructions
                      : [
                          'Open TradingView → Pine Editor → New script → paste from your clipboard',
                          'Add the script to your chart',
                          'Create alerts for Kaching Entry, Kaching SL, Kaching TP1, Kaching TP2, and Kaching TP3 with Webhook URL notifications',
                          'Enable TradingView mobile push notifications for real-time delivery'
                        ]
                    ).map(step => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>

                <div className="pine-script-actions">
                  <button
                    type="button"
                    className="btn-copy-script"
                    onClick={copyPineScript}
                    disabled={pineCopyState === 'loading'}
                  >
                    {pineCopyState === 'loading' ? 'Copying…' : 'Copy Script'}
                  </button>
                  <p className="pine-script-copy-note">
                    Your personal Pine Script is copied to the clipboard only — it is not shown on this page.
                  </p>
                  {!pineMeta && !pineLoadError && pineCopyState !== 'loading' && (
                    <p className="pine-script-loading">Preparing your script…</p>
                  )}
                  {pineLoadError && (
                    <p className="pine-script-copy-feedback error">{pineLoadError}</p>
                  )}
                  {pineCopyState === 'success' && (
                    <p className="pine-script-copy-feedback success">
                      Script copied. Paste it into the TradingView Pine Editor.
                    </p>
                  )}
                  {pineCopyState === 'error' && !pineLoadError && (
                    <p className="pine-script-copy-feedback error">
                      Could not copy the script. Allow clipboard access and try again.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'telegram' && (
        <div className="tv-section">
          {!subscribed ? (
            <div className="empty-state">Subscribe to link the KachingFx Telegram bot.</div>
          ) : (
            <TelegramSetup tierLimits={tierLimits} onNavigatePricing={onNavigatePricing} />
          )}
        </div>
      )}

      {activeTab === 'chart' && (
        <div className="tv-section">
          {!subscribed ? (
            <div className="empty-state">Subscribe to access the Kaching live chart.</div>
          ) : (
            <div className="history-section">
              <h3>Kaching Live Chart</h3>
              <p className="chart-subtitle">
                Historical and live candles with Kaching Entry, SL, TP, and pattern overlays.
              </p>
              <MarketChartPanel
                symbol={chartSymbol}
                allowedSymbols={symbols}
                onSymbolChange={setChartSymbol}
                overlaySignals={[...liveAlerts, ...alerts]}
                subscribed={subscribed}
                liveEnabled
              />
            </div>
          )}
        </div>
      )}

      {activeTab === 'history' && (
        <div className="tv-section">
          {!subscribed ? (
            <div className="empty-state">Subscribe to access historical data.</div>
          ) : (
            <div className="history-section">
              <h3>Historical Data</h3>
              <div className="controls">
                <select value={historySymbol} onChange={e => setHistorySymbol(e.target.value)}>
                  {symbols.map(symbol => (
                    <option key={symbol} value={symbol}>
                      {symbol}
                    </option>
                  ))}
                </select>
                <select value={selectedTimeframe} onChange={e => setSelectedTimeframe(e.target.value)}>
                  {timeframes.map(tf => (
                    <option key={tf} value={tf}>
                      {tf}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn-fetch" onClick={fetchHistoricalData} disabled={loading}>
                  {loading ? 'Loading...' : 'Fetch Data'}
                </button>
              </div>

              {historyError && <div className="feature-lock">{historyError}</div>}

              {tierLimits.newsFilter && historicalData.length > 0 && (
                <div className="indicators-box">
                  <h4>News Filter</h4>
                  <p>High-impact news filtering is active on your plan.</p>
                </div>
              )}

              {!tierLimits.newsFilter && historicalData.length > 0 && (
                <div className="feature-lock">🔒 News filter requires Pro or Premium</div>
              )}

              {historicalData.length > 0 && (
                <div className="history-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Open</th>
                        <th>High</th>
                        <th>Low</th>
                        <th>Close</th>
                        <th>Volume</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historicalData.slice(0, 20).map((candle, idx) => (
                        <tr key={idx}>
                          <td>{new Date(candle.time).toLocaleString()}</td>
                          <td>{candle.open.toFixed(5)}</td>
                          <td>{candle.high.toFixed(5)}</td>
                          <td>{candle.low.toFixed(5)}</td>
                          <td>{candle.close.toFixed(5)}</td>
                          <td>{(candle.volume / 1000000).toFixed(1)}M</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
