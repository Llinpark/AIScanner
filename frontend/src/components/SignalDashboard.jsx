import { useCallback, useEffect, useState } from 'react';
import { subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { getSharedSocket } from '../services/marketDataSocket';
import OutcomeBadge, { RiskAnalysisCard } from './insights/RiskAnalysisCard';
import AiExplanationCard from './insights/AiExplanationCard';
import MarketChartPanel from './charts/MarketChartPanel';
import SignalStatusPanel from './SignalStatusPanel';

const TIER_LABELS = { basic: 'Basic', professional: 'Pro', premium: 'Premium' };

const FEATURE_LABELS = [
  { key: 'showConfidence', label: 'Confidence Score', minTier: 'Pro' },
  { key: 'riskAnalysis', label: 'Risk Analysis', minTier: 'Pro' },
  { key: 'performanceDashboard', label: 'Analytics Dashboard', minTier: 'Pro' },
  { key: 'tradeJournal', label: 'Trade Journal', minTier: 'Pro' },
  { key: 'newsFilter', label: 'News Filter', minTier: 'Pro' },
  { key: 'telegramAlerts', label: 'Telegram Alerts', minTier: 'Pro' },
  { key: 'multiMarketScanner', label: 'Multi-Market Distribution', minTier: 'Premium' },
  { key: 'smartMoneyConcepts', label: 'Smart Money Concepts', minTier: 'Premium' },
  { key: 'tradeManagementAlerts', label: 'Trade Management Alerts', minTier: 'Premium' },
  { key: 'aiTradeExplanation', label: 'AI Trade Explanation', minTier: 'Premium' },
  { key: 'mt5Execution', label: 'One-click MT5 Execution', minTier: 'Pro' },
  { key: 'trailingStop', label: 'Trailing Stop', minTier: 'Pro' },
  { key: 'breakEvenAutomation', label: 'Break-even Automation', minTier: 'Pro' },
  { key: 'autoLotSizing', label: 'Auto Lot Sizing', minTier: 'Premium' }
];

function isActiveSubscription(subscription) {
  if (!subscription) return false;
  return subscription.status === 'active';
}

function signalStatusLabel(signal) {
  if (signal.outcome && signal.outcome !== 'pending') {
    return String(signal.outcome).toUpperCase();
  }
  return signal.tradeStatus === 'open' || !signal.tradeStatus ? 'Open' : signal.tradeStatus;
}

export default function SignalDashboard({ initialSignals, subscription, onNavigateReferrals }) {
  const { isAuthenticated } = useAuth();
  const [signals, setSignals] = useState(initialSignals || []);
  const [tierLimits, setTierLimits] = useState({});
  const [allowedPairs, setAllowedPairs] = useState(['EUR/USD', 'GBP/USD']);
  const [tierDisplayName, setTierDisplayName] = useState('Basic');
  const [performance, setPerformance] = useState(null);
  const [accountBalance, setAccountBalance] = useState(10000);
  const [expandedId, setExpandedId] = useState(null);
  const [chartSymbol, setChartSymbol] = useState('EUR/USD');
  const [chartError, setChartError] = useState(null);

  const onChartErrorChange = useCallback(err => setChartError(err), []);

  useEffect(() => {
    if (allowedPairs.length && !allowedPairs.includes(chartSymbol)) {
      setChartSymbol(allowedPairs[0]);
    }
  }, [allowedPairs, chartSymbol]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer = null;

    const loadMe = () => {
      subscriptionApi
        .getMe()
        .then(res => {
          if (cancelled) return;
          if (res.data.tierFeatures) setTierLimits(res.data.tierFeatures);
          if (res.data.allowedCurrencyPairs) setAllowedPairs(res.data.allowedCurrencyPairs);
          if (res.data.tierDisplayName) setTierDisplayName(res.data.tierDisplayName);
        })
        .catch(() => {
          if (!cancelled) retryTimer = window.setTimeout(loadMe, 5000);
        });
    };

    loadMe();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [subscription]);

  useEffect(() => {
    if (!tierLimits.performanceDashboard) return;
    subscriptionApi
      .getPerformanceSummary()
      .then(res => setPerformance(res.data))
      .catch(() => setPerformance(null));
  }, [tierLimits.performanceDashboard]);

  useEffect(() => {
    if (!isAuthenticated) return undefined;

    const socket = getSharedSocket();

    // Dashboard updates exclusively from TradingView webhook fan-out — no signal polling.
    socket.on('signal:update', newSignal => {
      setSignals(prev => [newSignal, ...prev].slice(0, tierLimits.maxSignals || 50));
    });

    socket.on('signal:outcome', updated => {
      setSignals(prev =>
        prev.map(s => (String(s._id) === String(updated._id) ? { ...s, ...updated } : s))
      );
    });

    return () => {
      socket.off('signal:update');
      socket.off('signal:outcome');
    };
  }, [isAuthenticated, tierLimits.maxSignals]);

  const hasAccess = isActiveSubscription(subscription);
  const tierKey = subscription?.tier || 'basic';

  return (
    <div className="dashboard-card">
      <div className="dashboard-hero-copy">
        <p className="dashboard-eyebrow">Kaching AI · Signal distribution</p>
        <h2>Recent Trade Signals</h2>
        <p className="dashboard-lead">
          TradingView is the signal source. Kaching distributes Entry, SL, TP, confidence, and commentary to your
          dashboard, Telegram, and MT5 — without regenerating trades from live market data.
        </p>
      </div>

      {!hasAccess && (
        <div className="subscription-banner">
          <p>Your subscription is {subscription?.status || 'inactive'}. Go to Pricing to upgrade.</p>
        </div>
      )}

      {onNavigateReferrals && (
        <div className="refer-earn-cta">
          <div className="refer-earn-cta-copy">
            <span className="refer-earn-badge">Refer &amp; Earn</span>
            <p>Share your link and earn commission on every subscription you refer.</p>
          </div>
          <button type="button" className="btn-fetch" onClick={onNavigateReferrals}>
            Open Refer &amp; Earn
          </button>
        </div>
      )}

      <div className="plan-summary">
        <p>
          <strong>{tierDisplayName}</strong> plan · {allowedPairs.length} pairs ·{' '}
          {(tierLimits.timeframes || ['1h']).join(', ')} timeframes · {tierLimits.historyDays || 7}-day history
        </p>
      </div>

      {hasAccess && (
        <div className="dashboard-status-row">
          <SignalStatusPanel chartError={chartError} />
        </div>
      )}

      {hasAccess && (
        <div className="dashboard-chart-section">
          <MarketChartPanel
            symbol={chartSymbol}
            allowedSymbols={allowedPairs}
            onSymbolChange={setChartSymbol}
            overlaySignals={signals}
            subscribed={hasAccess}
            liveEnabled
            height={600}
            onChartErrorChange={onChartErrorChange}
          />
        </div>
      )}

      {tierLimits.performanceDashboard && performance && (
        <div className="performance-box">
          <h3>Performance Snapshot</h3>
          <div className="performance-grid">
            <div className="performance-stat">
              <span>Win rate</span>
              <strong>{performance.winRate ?? performance.winRateEstimate ?? 0}%</strong>
            </div>
            <div className="performance-stat">
              <span>Closed trades</span>
              <strong>{performance.closedTrades ?? 0}</strong>
            </div>
            <div className="performance-stat">
              <span>Total R</span>
              <strong>{performance.totalR ?? 0}R</strong>
            </div>
            <div className="performance-stat">
              <span>Open trades</span>
              <strong>{performance.openTrades ?? 0}</strong>
            </div>
          </div>
        </div>
      )}

      <div className="signal-list">
        {signals.length === 0 ? (
          <div className="signal-empty">No TradingView signals yet for your plan pairs.</div>
        ) : (
          signals.map(signal => {
            const signalId = signal._id || signal.timestamp;
            const expanded = expandedId === signalId;
            const strategy =
              signal.strategyName || signal.strategy || signal.patternLabel || signal.pattern;

            return (
              <div key={signalId} className="signal-item" onClick={() => setChartSymbol(signal.symbol)}>
                <div className="signal-header">
                  <span>{signal.symbol}</span>
                  {strategy && <span className="pattern-badge">{strategy}</span>}
                  <OutcomeBadge outcome={signal.outcome} tradeStatus={signal.tradeStatus} />
                  <strong>{signal.direction.toUpperCase()}</strong>
                </div>
                <div className="signal-row signal-meta-row">
                  <span>Status: {signalStatusLabel(signal)}</span>
                  <span>TF: {signal.timeframe || '1h'}</span>
                  <span>Source: {signal.signalSource || signal.source || 'tradingview'}</span>
                </div>
                <div className="signal-row">
                  <span>Kaching Entry: {Number(signal.entry).toFixed(5)}</span>
                  <span>Kaching SL: {Number(signal.stop_loss_1 ?? signal.stop_loss).toFixed(5)}</span>
                </div>
                <div className="signal-row">
                  <span>Kaching TP1: {Number(signal.take_profit_1).toFixed(5)}</span>
                  <span>Kaching TP2: {Number(signal.take_profit_2).toFixed(5)}</span>
                  <span>Kaching TP3: {Number(signal.take_profit_3).toFixed(5)}</span>
                </div>
                <div className="signal-footer">
                  {tierLimits.showConfidence && signal.confidence != null ? (
                    <small>Confidence: {(Number(signal.confidence) * 100).toFixed(0)}%</small>
                  ) : (
                    <small>Confidence: upgrade to Pro</small>
                  )}
                  {signal.outcomeR != null && <small>Result: {signal.outcomeR}R</small>}
                  <span>{signal.notes}</span>
                </div>
                {tierLimits.aiTradeExplanation && (
                  <AiExplanationCard signal={signal} aiFactors={signal.aiFactors} tradeExplanation={signal.tradeExplanation} />
                )}
                {tierLimits.riskAnalysis && (
                  <>
                    <button
                      type="button"
                      className="btn-small signal-expand-btn"
                      onClick={e => {
                        e.stopPropagation();
                        setExpandedId(expanded ? null : signalId);
                      }}
                    >
                      {expanded ? 'Hide risk analysis' : 'Show risk analysis'}
                    </button>
                    {expanded && (
                      <RiskAnalysisCard
                        riskMetrics={signal.riskMetrics}
                        accountBalance={accountBalance}
                        onAccountBalanceChange={setAccountBalance}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })
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
        {tierLimits.mt5Execution && (
          <p className="api-hint">
            MT5 automation: one-click execution, trailing stops, break-even rules, and auto lot sizing from your account balance are enabled on your Premium plan.
          </p>
        )}
        {tierLimits.telegramAlerts && (
          <p className="telegram-hint">
            Telegram alerts are enabled for your {TIER_LABELS[tierKey] || tierDisplayName} plan.
          </p>
        )}
      </div>
    </div>
  );
}
