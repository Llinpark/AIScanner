import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getSharedSocket } from '../services/marketDataSocket';
import { tradingviewApi, subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import TelegramSetup from './TelegramSetup';
import MarketChartPanel from './charts/MarketChartPanel';
import { alertMatchesSymbol } from '../constants/markets';
import { isInsightsSignal } from '../utils/insightsSignal';

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

function AlertCard({ alert, showConfidence, showNewsFilter, showTradeManagement }) {
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
        {showNewsFilter && alert.newsImpact && alert.newsImpact !== 'none' && (
          <DetailRow label="News" value={alert.newsFilter?.label || alert.newsImpact} />
        )}
        {showTradeManagement && alert.tradeManagement?.message && (
          <DetailRow label="Management" value={alert.tradeManagement.message} />
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
  const { isAuthenticated } = useAuth();
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
  const [pineStrategy, setPineStrategy] = useState('daytrading');
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
    if (!subscribed) return undefined;
    let cancelled = false;
    let retryTimer = null;

    const loadTierLimits = () => {
      subscriptionApi
        .getMe()
        .then(res => {
          if (cancelled) return;
          if (res.data.tierFeatures) {
            setTierLimits(res.data.tierFeatures);
            const pairs = res.data.allowedCurrencyPairs || res.data.tierFeatures.currencyPairs || ['EUR/USD'];
            const frames = res.data.tierFeatures.timeframes || ['1h'];
            if (!pairs.includes(historySymbol)) setHistorySymbol(pairs[0]);
            if (!frames.includes(selectedTimeframe)) setSelectedTimeframe(frames[0]);
          }
        })
        .catch(() => {
          // Transient network/API errors shouldn't permanently strand the UI on the
          // fallback 2-pair default — retry a few seconds later.
          if (!cancelled) retryTimer = window.setTimeout(loadTierLimits, 5000);
        });
    };

    loadTierLimits();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [subscribed, subscription]);

  const fetchSetup = useCallback(async () => {
    try {
      const response = await tradingviewApi.getSetup();
      setSetup(response.data);
    } catch (error) {
      console.error('Failed to fetch TradingView setup:', error);
    }
  }, []);

  const loadPineScriptBundle = useCallback(async (strategy = pineStrategy) => {
    const response = await tradingviewApi.getPineScript(strategy);
    pineScriptRef.current = response.data.script || '';
    setPineMeta({
      webhookUrl: response.data.webhookUrl,
      scriptId: response.data.scriptId,
      tierLabel: response.data.tierLabel,
      subscriberLabel: response.data.subscriberLabel,
      generatedAt: response.data.generatedAt,
      security: response.data.security,
      instructions: response.data.instructions || [],
      samplePayload: response.data.samplePayload || null,
      flow: response.data.flow || null,
      strategy: response.data.strategy,
      strategyName: response.data.strategyName,
      availableStrategies: response.data.availableStrategies || []
    });
    return pineScriptRef.current;
  }, [pineStrategy]);

  const loadPineMeta = useCallback(async () => {
    setPineLoadError('');
    try {
      await loadPineScriptBundle(pineStrategy);
    } catch (error) {
      console.error('Failed to load Pine Script:', error);
      setPineLoadError(error.response?.data?.message || 'Unable to load your Pine Script. Try again or refresh the page.');
    }
  }, [loadPineScriptBundle, pineStrategy]);

  const fetchAlerts = useCallback(async () => {
    try {
      setLoading(true);
      const response = await tradingviewApi.getAlerts(liveFilter === 'ALL' ? null : liveFilter);
      setAlerts((response.data.alerts || []).filter(isInsightsSignal));
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
    if (!isAuthenticated || !subscribed) return undefined;

    const socket = getSharedSocket();

    socket.on('subscriber:ready', () => setSocketStatus('connected'));
    socket.on('connect', () => setSocketStatus('connected'));
    socket.on('disconnect', () => setSocketStatus('disconnected'));
    socket.on('connect_error', () => setSocketStatus('error'));

    socket.on('tv:live-alert', alert => {
      if (!isInsightsSignal(alert)) return;
      setLiveAlerts(prev => [alert, ...prev].slice(0, 100));
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('KachingFx Live Alert', { body: alert.message });
      }
    });

    return () => {
      socket.off('subscriber:ready');
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off('tv:live-alert');
    };
  }, [isAuthenticated, subscribed]);

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
    // Backend returns TradingView webhook alerts for any instrument (chart catalog is
    // separate). Only apply the user's manual symbol dropdown filter here — do not
    // re-filter against the chart-catalog `symbols` list or exotic alerts disappear.
    // Merge (instead of replace) so a single incoming live alert doesn't hide the
    // broader, properly tier-filtered history already loaded from the REST endpoint.
    const byId = new Map();
    for (const alert of alerts) {
      byId.set(String(alert.id || alert._id), alert);
    }
    for (const alert of liveAlerts) {
      byId.set(String(alert.id || alert._id), alert);
    }
    const merged = Array.from(byId.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return merged.filter(alert => alertMatchesSymbol(alert, liveFilter));
  }, [liveAlerts, alerts, liveFilter]);

  return (
    <div className="tv-dashboard">
      <div className="tv-header">
        <h2>TradingView Alert Setup</h2>
        <p>
          Connect TradingView alerts from any instrument to receive Entry, stop loss, and take-profit levels on your
          dashboard, Telegram, and MT5. In-app charts are display-only and never block alerts.
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
          {setup.webhookUrl && (
            <p className="setup-webhook-url">
              <strong>Webhook URL:</strong> <code>{setup.webhookUrl}</code>
            </p>
          )}
          <ol>
            {setup.instructions.map((step, idx) => (
              <li key={idx}>{step}</li>
            ))}
          </ol>
          {setup.chartProvidersNote && <p className="setup-note">{setup.chartProvidersNote}</p>}
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
          Auto Trading
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
              {(tierLimits.telegramAlerts || tierLimits.mt5Execution) && (
                <button type="button" className="btn-toggle" onClick={() => setActiveTab('telegram')}>
                  Open Auto Trading
                </button>
              )}
              </div>

              {displayAlerts.length === 0 ? (
                <div className="empty-state">
                  Waiting for live alerts. Finish TradingView setup, then wait for the next trade alert.
                </div>
              ) : (
                <div className="alerts-list">
                  {displayAlerts.map((alert, idx) => (
                    <AlertCard
                      key={alert.id || alert._id || idx}
                      alert={alert}
                      showConfidence={tierLimits.showConfidence}
                      showNewsFilter={tierLimits.newsFilter}
                      showTradeManagement={tierLimits.tradeManagementAlerts}
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
            <div className="empty-state">Subscribe first to unlock your personal TradingView script and setup guide.</div>
          ) : (
            <div className="pine-script-section">
              <h3>Connect TradingView</h3>
              <p>
                Copy your personal script, add it to a TradingView chart, then create one alert that sends to your
                webhook URL below. Kaching publishes those trades here — charts stay separate and display-only.
              </p>
              <p className="setup-note">
                Keep the script on your TradingView chart. When a signal fires it draws Entry, SL, TP1, TP2, and TP3
                lines on TradingView — included on Basic, Pro, and Premium.
              </p>
              {tierLimits.multiMarketScanner && (
                <p className="premium-feature-hint">
                  Premium: you receive alerts across all markets on your plan.
                </p>
              )}
              {tierLimits.smartMoneyConcepts && (
                <p className="premium-feature-hint">
                  Premium: additional Smart Money overlays (FVG / zones from alert metadata) on your in-app Kaching
                  charts — separate from the Entry / SL / TP lines on TradingView.
                </p>
              )}
              {tierLimits.mt5Execution && (
                <p className="premium-feature-hint">
                  Auto Trading (Pro+): connect MT5 in the Auto Trading tab. Pro uses Manual Execute; Premium can Auto-queue
                  trades without Telegram.
                </p>
              )}
              {tierLimits.trailingStop && (
                <p className="premium-feature-hint">
                  Trailing stop: after the trade fills, MT5 automatically trails your stop as price moves in your favor.
                </p>
              )}
              {tierLimits.breakEvenAutomation && (
                <p className="premium-feature-hint">
                  Break-even: once price reaches about 1R profit, MT5 moves your stop to entry (plus a small buffer).
                </p>
              )}
              {tierLimits.autoLotSizing && (
                <p className="premium-feature-hint">
                  Premium auto lot sizing: position size is calculated from your synced MT5 balance and risk %. Keep the
                  EA running so your balance stays up to date.
                </p>
              )}

              <div className="pine-script-box">
                <div className="pine-script-meta">
                  <label htmlFor="pine-strategy-select">
                    <strong>Strategy script:</strong>
                  </label>{' '}
                  <select
                    id="pine-strategy-select"
                    value={pineStrategy}
                    onChange={async e => {
                      const next = e.target.value;
                      setPineStrategy(next);
                      pineScriptRef.current = '';
                      setPineLoadError('');
                      try {
                        await loadPineScriptBundle(next);
                      } catch (error) {
                        setPineLoadError(
                          error.response?.data?.message || 'Unable to load strategy script.'
                        );
                      }
                    }}
                  >
                    <option value="daytrading">Liquidity Sweep + FVG (Day Trading)</option>
                    <option value="scalping">Liquidity Sweep + FVG (Scalping)</option>
                    <option value="classic">Classic (FVG / Breakaway)</option>
                  </select>
                  {pineMeta?.strategyName && (
                    <p className="setup-note">Active: {pineMeta.strategyName}</p>
                  )}
                </div>
                {pineMeta && (
                  <div className="pine-script-meta">
                    <p>
                      <strong>Generated for:</strong> {pineMeta.subscriberLabel} ({pineMeta.tierLabel})
                    </p>
                    <p className="setup-webhook-url">
                      <strong>Webhook URL:</strong> <code>{pineMeta.webhookUrl}</code>
                    </p>
                    <p>
                      <strong>Script ID:</strong> {pineMeta.scriptId}
                      {pineMeta.generatedAt && (
                        <span> · {new Date(pineMeta.generatedAt).toLocaleString()}</span>
                      )}
                    </p>
                    {pineMeta.security?.authNote && (
                      <p>
                        <strong>Privacy:</strong> {pineMeta.security.authNote}
                      </p>
                    )}
                    <p className="setup-note">
                      Charts are display-only. Chart feed issues never block alerts.
                      {pineStrategy === 'scalping'
                        ? ' Scalping: use a 1m or 3m chart; HTF liquidity is 15m context only.'
                        : pineStrategy === 'daytrading'
                          ? ' Day Trading: use a 15m or 5m chart; HTF bias/liquidity is 4H context only.'
                          : ''}
                    </p>
                  </div>
                )}

                <div className="pine-script-instructions">
                  <ol>
                    {(pineMeta?.instructions?.length
                      ? pineMeta.instructions
                      : [
                          'Open TradingView → Pine Editor → paste your personal script → Add to chart',
                          'Keep the script on the chart so Entry, SL, and TP1–3 overlays draw when signals fire',
                          'Create one alert for this script and enable webhook notifications',
                          'Paste your Kaching webhook URL into the alert',
                          'Optional: enable TradingView mobile notifications'
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
            <div className="empty-state">Subscribe to set up Auto Trading (Telegram + MT5).</div>
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
                Charts are for display only. Trade levels come from your TradingView alerts — chart outages never block
                alerts.
              </p>
              <MarketChartPanel
                symbol={chartSymbol}
                allowedSymbols={symbols}
                onSymbolChange={setChartSymbol}
                overlaySignals={[...liveAlerts, ...alerts]}
                subscribed={subscribed}
                liveEnabled
                enableSmcOverlays={Boolean(tierLimits.smartMoneyConcepts)}
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
                  <p>
                    High-impact news windows (NFP / US data heuristics) are evaluated on each alert. Signals may show a
                    News badge when risk is elevated — use it to skip or size down new entries.
                  </p>
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
