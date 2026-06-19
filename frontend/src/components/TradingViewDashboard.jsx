import { useState, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { tradingviewApi, subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

const ALERT_LABELS = {
  entry: 'Entry',
  stop_loss: 'Stop Loss',
  take_profit_1: 'Take Profit 1',
  take_profit_2: 'Take Profit 2',
  take_profit_3: 'Take Profit 3',
  signal: 'Signal'
};

function hasLiveAccess(subscription) {
  if (!subscription) return false;
  if (subscription.status === 'active') return true;
  if (subscription.status === 'trial') {
    if (!subscription.trialEnds) return true;
    return new Date(subscription.trialEnds) > new Date();
  }
  return false;
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
        <DetailRow label="Entry" value={Number(alert.entry).toFixed(5)} />
        <DetailRow
          label="Stop Losses"
          value={`${Number(alert.stop_loss_1 ?? alert.stop_loss).toFixed(5)} / ${Number(alert.stop_loss_2 ?? alert.stop_loss).toFixed(5)} / ${Number(alert.stop_loss_3 ?? alert.stop_loss).toFixed(5)}`}
        />
        <DetailRow
          label="Take Profits"
          value={`${Number(alert.take_profit_1).toFixed(5)} / ${Number(alert.take_profit_2).toFixed(5)} / ${Number(alert.take_profit_3).toFixed(5)}`}
        />
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

export default function TradingViewDashboard({ subscription, onNavigatePricing }) {
  const { token } = useAuth();
  const [setup, setSetup] = useState(null);
  const [selectedSymbol, setSelectedSymbol] = useState('EUR/USD');
  const [historicalData, setHistoricalData] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [liveAlerts, setLiveAlerts] = useState([]);
  const [indicators, setIndicators] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('live');
  const [showPineScript, setShowPineScript] = useState(false);
  const [pineScript, setPineScript] = useState('');
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
    if (!subscribed) return;
    subscriptionApi
      .getMe()
      .then(res => {
        if (res.data.tierFeatures) {
          setTierLimits(res.data.tierFeatures);
          const pairs = res.data.allowedCurrencyPairs || res.data.tierFeatures.currencyPairs || ['EUR/USD'];
          const frames = res.data.tierFeatures.timeframes || ['1h'];
          if (!pairs.includes(selectedSymbol)) setSelectedSymbol(pairs[0]);
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

  const loadPineScript = useCallback(async () => {
    try {
      const response = await tradingviewApi.getPineScript();
      setPineScript(response.data.script);
    } catch (error) {
      console.error('Failed to load Pine Script:', error);
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
    try {
      setLoading(true);
      const response = await tradingviewApi.getAlerts(selectedSymbol);
      setAlerts(response.data.alerts);
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
    } finally {
      setLoading(false);
    }
  }, [selectedSymbol]);

  useEffect(() => {
    if (subscribed) {
      fetchSetup();
      loadPineScript();
    }
  }, [subscribed, fetchSetup, loadPineScript]);

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
      if (alert.symbol === selectedSymbol) {
        setAlerts(prev => [alert, ...prev].slice(0, 50));
      }
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('KachingFx Live Alert', { body: alert.message });
      }
    });

    return () => socket.disconnect();
  }, [token, subscribed, selectedSymbol]);

  const fetchHistoricalData = async () => {
    try {
      setLoading(true);
      setHistoryError('');
      const response = await tradingviewApi.getHistory(selectedSymbol, { interval: selectedTimeframe });
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

  const requestNotifications = () => {
    if (typeof Notification !== 'undefined') {
      Notification.requestPermission();
    }
  };

  const copyPineScript = () => {
    navigator.clipboard.writeText(pineScript);
    alert('Pine Script copied to clipboard!');
  };

  const displayAlerts = liveAlerts.length ? liveAlerts : alerts;

  return (
    <div className="tv-dashboard">
      <div className="tv-header">
        <h2>TradingView Alert Setup</h2>
        <p>
          After subscribing, open TradingView to receive accurate Entry, Stop Loss, Take Profit 1, 2, and 3 alerts.
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
        <button type="button" className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>
          History
        </button>
      </div>

      {activeTab === 'live' && (
        <div className="tv-section">
          {!subscribed ? (
            <div className="empty-state">Subscribe to receive live Entry, SL, and TP alerts.</div>
          ) : (
            <>
              <div className="live-controls">
                <select value={selectedSymbol} onChange={e => setSelectedSymbol(e.target.value)}>
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
                <button type="button" className="btn-toggle" onClick={requestNotifications}>
                  Enable browser / Telegram-style notifications
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
                <strong>Entry</strong>, <strong>Stop Loss</strong>, <strong>Take Profit 1</strong>,{' '}
                <strong>Take Profit 2</strong>, and <strong>Take Profit 3</strong>.
                Enable TradingView push or email notifications so alerts reach you instantly.
              </p>
              <button type="button" className="btn-toggle" onClick={() => setShowPineScript(!showPineScript)}>
                {showPineScript ? '▼' : '▶'} Show Pine Script
              </button>
              {tierLimits.multiMarketScanner && (
                <p className="premium-feature-hint">Multi-market scanner enabled on your Premium plan.</p>
              )}
              {tierLimits.smartMoneyConcepts && (
                <p className="premium-feature-hint">Smart Money Concepts overlays included.</p>
              )}
              {tierLimits.propFirmMode && (
                <p className="premium-feature-hint">Prop firm mode: drawdown guardrails active.</p>
              )}
              {showPineScript && pineScript && (
                <div className="pine-script-box">
                  <div className="pine-script-instructions">
                    <ol>
                      <li>Open TradingView → Pine Editor → New script → paste the code below</li>
                      <li>Add the script to your chart</li>
                      <li>Create alerts for Entry, Stop Loss, TP1, TP2, and TP3 with Webhook URL notifications</li>
                      <li>Enable TradingView mobile push notifications for real-time delivery</li>
                    </ol>
                  </div>
                  <div className="pine-script-code-container">
                    <pre id="pine-script-code">{pineScript}</pre>
                    <button type="button" className="btn-copy" onClick={copyPineScript}>
                      Copy Script
                    </button>
                  </div>
                </div>
              )}
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
                <select value={selectedSymbol} onChange={e => setSelectedSymbol(e.target.value)}>
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
