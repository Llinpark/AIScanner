import { useState, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import { tradingviewApi } from '../services/api';
<<<<<<< HEAD
import { useAuth } from '../context/AuthContext';
=======
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162

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
        <DetailRow
          label="Stop Losses"
          value={`${Number(alert.stop_loss_1 ?? alert.stop_loss).toFixed(5)} / ${Number(alert.stop_loss_2 ?? alert.stop_loss).toFixed(5)} / ${Number(alert.stop_loss_3 ?? alert.stop_loss).toFixed(5)}`}
        />
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

<<<<<<< HEAD
export default function TradingViewDashboard({ subscription, onNavigatePricing }) {
  const { token } = useAuth();
  const [setup, setSetup] = useState(null);
=======
export default function TradingViewDashboard({ username, subscription, onNavigatePricing }) {
  const [accounts, setAccounts] = useState(null);
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
  const [selectedSymbol, setSelectedSymbol] = useState('EUR/USD');
  const [historicalData, setHistoricalData] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [liveAlerts, setLiveAlerts] = useState([]);
  const [indicators, setIndicators] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('live');
<<<<<<< HEAD
  const [showPineScript, setShowPineScript] = useState(false);
  const [pineScript, setPineScript] = useState('');
=======
  const [linkedUsername, setLinkedUsername] = useState('');
  const [showPineScript, setShowPineScript] = useState(false);
  const [pineScript, setPineScript] = useState('');
  const [linkError, setLinkError] = useState(null);
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
  const [socketStatus, setSocketStatus] = useState('disconnected');

  const symbols = ['EUR/USD', 'GBP/USD', 'AUD/USD', 'USD/JPY'];
  const subscribed = hasLiveAccess(subscription);
<<<<<<< HEAD

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
=======
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
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
      setPineScript(response.data.script);
    } catch (error) {
      console.error('Failed to load Pine Script:', error);
    }
  }, []);

  const fetchAlerts = useCallback(async () => {
<<<<<<< HEAD
    try {
      setLoading(true);
      const response = await tradingviewApi.getAlerts(selectedSymbol);
=======
    if (!tvUsername) return;
    try {
      setLoading(true);
      const response = await tradingviewApi.getAlerts(tvUsername, selectedSymbol, username);
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
      setAlerts(response.data.alerts);
    } catch (error) {
      console.error('Failed to fetch alerts:', error);
    } finally {
      setLoading(false);
    }
<<<<<<< HEAD
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
=======
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
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162

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
<<<<<<< HEAD
  }, [token, subscribed, selectedSymbol]);
=======
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
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162

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
<<<<<<< HEAD
        <h2>TradingView Alert Setup</h2>
        <p>
          After subscribing, open TradingView to receive accurate Entry, Stop Loss, Take Profit 1, 2, and 3 alerts.
          No TradingView username linking is required.
        </p>
=======
        <h2>TradingView Live Alerts</h2>
        <p>Link your TradingView username to receive live entry, stop loss, and take profit alerts.</p>
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
      </div>

      {!subscribed && (
        <div className="subscription-banner">
          <p>
<<<<<<< HEAD
            Subscribe to unlock live alerts and the TradingView setup guide.{' '}
=======
            Active subscription required for live TradingView alerts.{' '}
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
            <button type="button" className="btn-link-inline" onClick={onNavigatePricing}>
              View pricing
            </button>
          </p>
        </div>
      )}

<<<<<<< HEAD
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
=======
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
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162

      <div className="tv-tabs">
        <button type="button" className={`tab-btn ${activeTab === 'live' ? 'active' : ''}`} onClick={() => setActiveTab('live')}>
          Live Alerts
        </button>
<<<<<<< HEAD
        <button type="button" className={`tab-btn ${activeTab === 'setup' ? 'active' : ''}`} onClick={() => setActiveTab('setup')}>
          TradingView Setup
=======
        <button type="button" className={`tab-btn ${activeTab === 'link' ? 'active' : ''}`} onClick={() => setActiveTab('link')}>
          Link &amp; Setup
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
        </button>
        <button type="button" className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`} onClick={() => setActiveTab('history')}>
          History
        </button>
      </div>

      {activeTab === 'live' && (
        <div className="tv-section">
<<<<<<< HEAD
          {!subscribed ? (
            <div className="empty-state">Subscribe to receive live Entry, SL, and TP alerts.</div>
=======
          {!tvUsername ? (
            <div className="empty-state">Link your TradingView username under Link &amp; Setup to receive live alerts.</div>
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
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
<<<<<<< HEAD
                <button type="button" className="btn-fetch" onClick={fetchAlerts} disabled={loading}>
=======
                <button type="button" className="btn-fetch" onClick={fetchAlerts} disabled={loading || !subscribed}>
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
                  Refresh
                </button>
                <button type="button" className="btn-toggle" onClick={requestNotifications}>
                  Enable browser notifications
                </button>
              </div>

              {displayAlerts.length === 0 ? (
                <div className="empty-state">
<<<<<<< HEAD
                  Waiting for live alerts. Set up TradingView using the Setup tab, or wait for the next broadcast signal.
=======
                  Waiting for live alerts. Add the Pine Script to TradingView and create a webhook alert, or wait for broadcast signals from KachingFx.
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
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

<<<<<<< HEAD
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
=======
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
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
              </p>
              <button type="button" className="btn-toggle" onClick={() => setShowPineScript(!showPineScript)}>
                {showPineScript ? '▼' : '▶'} Show Pine Script
              </button>
              {showPineScript && pineScript && (
                <div className="pine-script-box">
                  <div className="pine-script-instructions">
                    <ol>
<<<<<<< HEAD
                      <li>Open TradingView → Pine Editor → New script → paste the code below</li>
                      <li>Add the script to your chart</li>
                      <li>Create alerts for Entry, Stop Loss, TP1, TP2, and TP3 with Webhook URL notifications</li>
                      <li>Enable TradingView mobile push notifications for real-time delivery</li>
=======
                      <li>Open TradingView → Pine Editor → New script → paste the code</li>
                      <li>Set <strong>Your TradingView Username</strong> in script settings</li>
                      <li>Add to chart, then Create Alert → Webhook URL → use the alert message JSON</li>
                      <li>For KachingFx master signals, enable <strong>Broadcast to all subscribers</strong> (publishers only)</li>
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
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
<<<<<<< HEAD
          )}
=======
          </div>
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
        </div>
      )}

      {activeTab === 'history' && (
        <div className="tv-section">
<<<<<<< HEAD
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
          )}
=======
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
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
        </div>
      )}
    </div>
  );
}
