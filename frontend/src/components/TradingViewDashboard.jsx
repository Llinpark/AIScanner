import { useState, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { tradingviewApi } from '../services/api';

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

function AlertCard({ alert }) {
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
        <DetailRow label="Stop Loss" value={Number(alert.stop_loss).toFixed(5)} />
        <DetailRow
          label="Take Profits"
          value={`${Number(alert.take_profit_1).toFixed(5)} / ${Number(alert.take_profit_2).toFixed(5)} / ${Number(alert.take_profit_3).toFixed(5)}`}
        />
        {alert.confidence > 0 && (
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

export default function TradingViewDashboard({ username, subscription, onNavigatePricing }) {
  const [accounts, setAccounts] = useState(null);
  const [selectedSymbol, setSelectedSymbol] = useState('EUR/USD');
  const [historicalData, setHistoricalData] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [liveAlerts, setLiveAlerts] = useState([]);
  const [indicators, setIndicators] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('live');
  const [linkedUsername, setLinkedUsername] = useState('');
  const [showPineScript, setShowPineScript] = useState(false);
  const [pineScript, setPineScript] = useState('');
  const [linkError, setLinkError] = useState(null);
  const [socketStatus, setSocketStatus] = useState('disconnected');

  const symbols = ['EUR/USD', 'GBP/USD', 'AUD/USD', 'USD/JPY'];
  const subscribed = hasLiveAccess(subscription);
  const tvUsername = accounts?.tradingviewUsername;

  const fetchAccounts = useCallback(async () => {
    try {
      const response = await tradingviewApi.getAccounts(username);
      setAccounts(response.data);
    } catch (error) {
      console.error('Failed to fetch TradingView accounts:', error);
    }
  }, [username]);

  const loadPineScript = useCallback(async (tvUser) => {
    try {
      const response = await tradingviewApi.getPineScript(tvUser);
      setPineScript(response.data.script);
    } catch (error) {
      console.error('Failed to load Pine Script:', error);
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
    if (!tvUsername) return;
    try {
      setLoading(true);
      const response = await tradingviewApi.getAlerts(tvUsername, selectedSymbol, username);
      setAlerts(response.data.alerts);
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
    } finally {
      setLoading(false);
    }
  }, [tvUsername, selectedSymbol, username]);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  useEffect(() => {
    if (tvUsername && subscribed) {
      fetchAlerts();
      loadPineScript(tvUsername);
    }
  }, [tvUsername, subscribed, fetchAlerts, loadPineScript]);

  useEffect(() => {
    if (!username || !tvUsername || !subscribed) return undefined;

    const socket = io(SOCKET_URL);
    socket.emit('tv:subscribe', { appUsername: username, tradingviewUsername: tvUsername });

    socket.on('tv:subscribed', () => setSocketStatus('connected'));
    socket.on('tv:subscribe-error', () => setSocketStatus('error'));
    socket.on('connect', () => setSocketStatus('connected'));
    socket.on('disconnect', () => setSocketStatus('disconnected'));

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
  }, [username, tvUsername, subscribed, selectedSymbol]);

  const handleLinkAccount = async () => {
    setLinkError(null);
    try {
      if (!linkedUsername.trim()) {
        setLinkError('Please enter your TradingView username');
        return;
      }
      if (!subscribed) {
        setLinkError('Active subscription required. Subscribe on the Pricing page first.');
        return;
      }

      const response = await tradingviewApi.linkAccount({
        username,
        tradingviewUsername: linkedUsername.trim()
      });

      const linked = response.data.tradingviewUsername || response.data.user?.tradingviewUsername;
      setAccounts(prev => ({ ...prev, tradingviewUsername: linked }));
      setLinkedUsername('');
      await loadPineScript(linked);
    } catch (error) {
      setLinkError(error.response?.data?.message || error.message);
    }
  };

  const fetchHistoricalData = async () => {
    try {
      setLoading(true);
      const response = await tradingviewApi.getHistory(selectedSymbol);
      setHistoricalData(response.data.data);
      setIndicators(response.data.indicators);
    } catch (error) {
      console.error('Failed to fetch historical data:', error);
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
        <h2>TradingView Live Alerts</h2>
        <p>Link your TradingView username to receive live entry, stop loss, and take profit alerts.</p>
      </div>

      {!subscribed && (
        <div className="subscription-banner">
          <p>
            Active subscription required for live TradingView alerts.{' '}
            <button type="button" className="btn-link-inline" onClick={onNavigatePricing}>
              View pricing
            </button>
          </p>
        </div>
      )}

      <div className="account-status">
        <div className="status-card">
          <h3>Account Status</h3>
          {tvUsername ? (
            <div className="status-active">
              <span className="badge-success">Linked</span>
              <p>
                TradingView: <strong>{tvUsername}</strong>
              </p>
              <p>Live feed: {socketStatus === 'connected' ? 'Connected' : 'Connecting…'}</p>
            </div>
          ) : (
            <div className="status-inactive">
              <span className="badge-inactive">Not Connected</span>
              <p>Link your TradingView username to start receiving alerts</p>
            </div>
          )}
        </div>
      </div>

      <div className="tv-tabs">
        <button type="button" className={`tab-btn ${activeTab === 'live' ? 'active' : ''}`} onClick={() => setActiveTab('live')}>
          Live Alerts
        </button>
        <button type="button" className={`tab-btn ${activeTab === 'link' ? 'active' : ''}`} onClick={() => setActiveTab('link')}>
          Link &amp; Setup
        </button>
        <button type="button" className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>
          History
        </button>
      </div>

      {activeTab === 'live' && (
        <div className="tv-section">
          {!tvUsername ? (
            <div className="empty-state">Link your TradingView username under Link &amp; Setup to receive live alerts.</div>
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
                <button type="button" className="btn-fetch" onClick={fetchAlerts} disabled={loading || !subscribed}>
                  Refresh
                </button>
                <button type="button" className="btn-toggle" onClick={requestNotifications}>
                  Enable browser notifications
                </button>
              </div>

              {displayAlerts.length === 0 ? (
                <div className="empty-state">
                  Waiting for live alerts. Add the Pine Script to TradingView and create a webhook alert, or wait for broadcast signals from KachingFx.
                </div>
              ) : (
                <div className="alerts-list">
                  {displayAlerts.map((alert, idx) => (
                    <AlertCard key={alert.id || alert._id || idx} alert={alert} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === 'link' && (
        <div className="tv-section">
          <div className="link-section">
            <h3>Link Your TradingView Username</h3>
            <p className="link-help">
              Use the exact username from your TradingView profile. All live entry, SL, and TP alerts will be routed to this account.
            </p>

            <div className="link-option">
              <h4>Subscriber linking</h4>
              <input
                type="text"
                placeholder="Your TradingView username"
                value={linkedUsername}
                onChange={e => setLinkedUsername(e.target.value)}
                disabled={!subscribed}
              />
              {linkError && <p className="app-error">{linkError}</p>}
              <button type="button" className="btn-link" onClick={handleLinkAccount} disabled={!subscribed}>
                Link TradingView Username
              </button>
            </div>

            <div className="pine-script-section">
              <h3>TradingView Pine Script</h3>
              <p>
                Add this script to your chart. Create an alert with <strong>Webhook URL</strong> pointing to your KachingFx backend.
                Set your username to <strong>{tvUsername || 'your linked username'}</strong> in the script inputs.
              </p>
              <button type="button" className="btn-toggle" onClick={() => setShowPineScript(!showPineScript)}>
                {showPineScript ? '▼' : '▶'} Show Pine Script
              </button>
              {showPineScript && pineScript && (
                <div className="pine-script-box">
                  <div className="pine-script-instructions">
                    <ol>
                      <li>Open TradingView → Pine Editor → New script → paste the code</li>
                      <li>Set <strong>Your TradingView Username</strong> in script settings</li>
                      <li>Add to chart, then Create Alert → Webhook URL → use the alert message JSON</li>
                      <li>For KachingFx master signals, enable <strong>Broadcast to all subscribers</strong> (publishers only)</li>
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
          </div>
        </div>
      )}

      {activeTab === 'history' && (
        <div className="tv-section">
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
              <button type="button" className="btn-fetch" onClick={fetchHistoricalData} disabled={loading}>
                {loading ? 'Loading...' : 'Fetch Data'}
              </button>
            </div>

            {indicators && (
              <div className="indicators-box">
                <h4>Current Indicators</h4>
                <div className="indicator-grid">
                  <div className="indicator-item">
                    <span className="label">SMA (14)</span>
                    <span className="value">{indicators.sma}</span>
                  </div>
                  <div className="indicator-item">
                    <span className="label">RSI (14)</span>
                    <span className="value">{indicators.rsi}</span>
                  </div>
                  <div className="indicator-item">
                    <span className="label">Close</span>
                    <span className="value">{indicators.currentClose}</span>
                  </div>
                </div>
              </div>
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
        </div>
      )}
    </div>
  );
}
