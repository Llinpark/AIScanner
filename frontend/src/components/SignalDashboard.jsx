import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

const TIER_LABELS = { basic: 'Basic', professional: 'Pro', premium: 'Premium' };

const FEATURE_LABELS = [
  { key: 'showConfidence', label: 'Confidence Score', minTier: 'Pro' },
  { key: 'newsFilter', label: 'News Filter', minTier: 'Pro' },
  { key: 'performanceDashboard', label: 'Performance Dashboard', minTier: 'Pro' },
  { key: 'telegramAlerts', label: 'Telegram Alerts', minTier: 'Pro' },
  { key: 'multiMarketScanner', label: 'Multi-Market Scanner', minTier: 'Premium' },
  { key: 'smartMoneyConcepts', label: 'Smart Money Concepts', minTier: 'Premium' },
  { key: 'tradeManagementAlerts', label: 'Trade Management Alerts', minTier: 'Premium' },
  { key: 'aiTradeExplanation', label: 'AI Trade Explanation', minTier: 'Premium' },
  { key: 'propFirmMode', label: 'Prop Firm Mode', minTier: 'Premium' },
  { key: 'apiAccess', label: 'API Access', minTier: 'Premium' }
];

function isActiveSubscription(subscription) {
  if (!subscription) return false;
  return subscription.status === 'active';
}

export default function SignalDashboard({ initialSignals, subscription }) {
  const { token, isAuthenticated } = useAuth();
  const [signals, setSignals] = useState(initialSignals || []);
  const [tierLimits, setTierLimits] = useState({});
  const [allowedPairs, setAllowedPairs] = useState(['EUR/USD', 'GBP/USD']);
  const [tierDisplayName, setTierDisplayName] = useState('Basic');
  const [performance, setPerformance] = useState(null);

  useEffect(() => {
    subscriptionApi
      .getMe()
      .then(res => {
        if (res.data.tierFeatures) setTierLimits(res.data.tierFeatures);
        if (res.data.allowedCurrencyPairs) setAllowedPairs(res.data.allowedCurrencyPairs);
        if (res.data.tierDisplayName) setTierDisplayName(res.data.tierDisplayName);
      })
      .catch(() => {});
  }, [subscription]);

  useEffect(() => {
    if (!tierLimits.performanceDashboard) return;
    subscriptionApi
      .getPerformanceSummary()
      .then(res => setPerformance(res.data))
      .catch(() => setPerformance(null));
  }, [tierLimits.performanceDashboard]);

  useEffect(() => {
    if (!token || !isAuthenticated) return undefined;

    const socket = io(SOCKET_URL, { auth: { token } });

    socket.on('signal:update', newSignal => {
      setSignals(prev => [newSignal, ...prev].slice(0, tierLimits.maxSignals || 50));
    });

    return () => socket.disconnect();
  }, [token, isAuthenticated, tierLimits.maxSignals]);

  const hasAccess = isActiveSubscription(subscription);
  const tierKey = subscription?.tier || 'basic';

  return (
    <div className="dashboard-card">
      <h2>Recent Trade Signals</h2>

      {!hasAccess && (
        <div className="subscription-banner">
          <p>⚠️ Your subscription is {subscription?.status || 'inactive'}. Go to Pricing to upgrade.</p>
        </div>
      )}

      <div className="plan-summary">
        <p>
          <strong>{tierDisplayName}</strong> plan · {allowedPairs.length} pairs ·{' '}
          {(tierLimits.timeframes || ['1h']).join(', ')} timeframes · {tierLimits.historyDays || 7}-day history
        </p>
      </div>

      {tierLimits.performanceDashboard && performance && (
        <div className="performance-box">
          <h3>Performance Dashboard</h3>
          <div className="performance-grid">
            <div className="performance-stat">
              <span>Total signals</span>
              <strong>{performance.totalSignals}</strong>
            </div>
            <div className="performance-stat">
              <span>Long / Short</span>
              <strong>
                {performance.longSignals} / {performance.shortSignals}
              </strong>
            </div>
            <div className="performance-stat">
              <span>Win rate est.</span>
              <strong>{performance.winRateEstimate}%</strong>
            </div>
          </div>
        </div>
      )}

      <div className="signal-list">
        {signals.length === 0 ? (
          <div className="signal-empty">No signals available for your plan pairs.</div>
        ) : (
          signals.map(signal => (
            <div key={signal._id || signal.timestamp} className="signal-item">
              <div className="signal-header">
                <span>{signal.symbol}</span>
                {signal.pattern && <span className="pattern-badge">{signal.patternLabel || signal.pattern}</span>}
                <strong>{signal.direction.toUpperCase()}</strong>
              </div>
              <div className="signal-row">
                <span>Kaching Entry: {signal.entry.toFixed(5)}</span>
                <span>Kaching SL: {(signal.stop_loss_1 ?? signal.stop_loss).toFixed(5)}</span>
              </div>
              <div className="signal-row">
                <span>Kaching TP1: {signal.take_profit_1.toFixed(5)}</span>
                <span>Kaching TP2: {signal.take_profit_2.toFixed(5)}</span>
                <span>Kaching TP3: {signal.take_profit_3.toFixed(5)}</span>
              </div>
              <div className="signal-footer">
                {tierLimits.showConfidence && signal.confidence != null ? (
                  <small>Confidence: {(signal.confidence * 100).toFixed(0)}%</small>
                ) : (
                  <small>Confidence: upgrade to Pro</small>
                )}
                {tierLimits.aiTradeExplanation && signal.tradeExplanation && (
                  <small className="ai-explanation">{signal.tradeExplanation}</small>
                )}
                <span>{signal.notes}</span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="dashboard-footer">
        <h3>Plan features</h3>
        <div className="feature-grid">
          <div className="feature-item enabled">✓ AI Alerts</div>
          <div className="feature-item enabled">✓ TradingView Alerts</div>
          {FEATURE_LABELS.map(item => (
            <div key={item.key} className={`feature-item ${tierLimits[item.key] ? 'enabled' : 'locked'}`}>
              {tierLimits[item.key] ? '✓' : '✗'} {item.label}
              {!tierLimits[item.key] && <small> ({item.minTier}+)</small>}
            </div>
          ))}
        </div>
        {tierLimits.apiAccess && (
          <p className="api-hint">
            REST API: <code>GET /api/v1/signals</code> with your Bearer token
          </p>
        )}
        {tierLimits.telegramAlerts && (
          <p className="telegram-hint">Telegram alerts are enabled for your {TIER_LABELS[tierKey] || tierDisplayName} plan.</p>
        )}
      </div>
    </div>
  );
}
