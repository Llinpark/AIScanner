import { useCallback, useEffect, useMemo, useState } from 'react';
import { subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { getSharedSocket } from '../services/marketDataSocket';
import OutcomeBadge, { RiskAnalysisCard } from './insights/RiskAnalysisCard';
import AiExplanationCard from './insights/AiExplanationCard';
import MarketChartPanel from './charts/MarketChartPanel';
import SignalStatusPanel from './SignalStatusPanel';
import {
  formatSignalSource,
  formatStrategyName,
  isInsightsSignal
} from '../utils/insightsSignal';
import {
  getExpiryDisplayLabel,
  getPlanDisplayLabel,
  getRemainingDaysDisplay,
  getStatusDisplayLabel,
  hasAdminUnlimitedAccess
} from '../utils/subscriptionDisplay';

const TIER_LABELS = { basic: 'Basic', professional: 'Pro', premium: 'Premium' };

const FEATURE_LABELS = [
  { key: 'showConfidence', label: 'Confidence Score', minTier: 'Pro' },
  { key: 'riskAnalysis', label: 'Risk Analysis', minTier: 'Pro' },
  { key: 'performanceDashboard', label: 'Analytics Dashboard', minTier: 'Pro' },
  { key: 'advancedAnalytics', label: 'Advanced Analytics', minTier: 'Premium' },
  { key: 'tradeJournal', label: 'Trade Journal', minTier: 'Pro' },
  { key: 'newsFilter', label: 'News Filter', minTier: 'Pro' },
  { key: 'telegramAlerts', label: 'Telegram Notifications', minTier: 'Pro' },
  { key: 'emailAlerts', label: 'Email Alerts', minTier: 'Basic' },
  { key: 'multiMarketScanner', label: 'Multi-Market Distribution', minTier: 'Premium' },
  { key: 'smartMoneyConcepts', label: 'Smart Money Concepts', minTier: 'Premium' },
  { key: 'tradeManagementAlerts', label: 'Trade Management Alerts', minTier: 'Premium' },
  { key: 'aiTradeExplanation', label: 'AI Trade Explanation', minTier: 'Premium' },
  { key: 'mt5Execution', label: 'MT5 Execution', minTier: 'Pro' },
  { key: 'mt5AutoExecution', label: 'Automatic MT5 Execution', minTier: 'Premium' },
  { key: 'trailingStop', label: 'Trailing Stop', minTier: 'Pro' },
  { key: 'breakEvenAutomation', label: 'Break-even Automation', minTier: 'Pro' },
  { key: 'autoLotSizing', label: 'Auto Lot Sizing', minTier: 'Premium' }
];

function isActiveSubscription(subscription) {
  if (!subscription) return false;
  return subscription.status === 'active';
}

function formatShortDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString();
}

function subscriptionBannerCopy(subscription) {
  const status = subscription?.status || 'pending';
  if (status === 'pending') {
    return 'Awaiting Verification — your payment is being reviewed. Live alerts unlock once a Super Admin activates your plan.';
  }
  if (status === 'expired') {
    return 'Subscription Expired — renew on Pricing to restore live alerts and premium features.';
  }
  if (status === 'cancelled') {
    return 'Your subscription was cancelled. Go to Pricing to subscribe again.';
  }
  return `Your subscription is ${status}. Go to Pricing to upgrade.`;
}

function signalStatusLabel(signal) {
  if (signal.outcome && signal.outcome !== 'pending') {
    return String(signal.outcome).toUpperCase();
  }
  return signal.tradeStatus === 'open' || !signal.tradeStatus ? 'Open' : signal.tradeStatus;
}

export default function SignalDashboard({ initialSignals, subscription, onNavigateReferrals }) {
  const { isAuthenticated, user } = useAuth();
  const [signals, setSignals] = useState(() =>
    (initialSignals || []).filter(isInsightsSignal)
  );
  const [tierLimits, setTierLimits] = useState({});
  const [allowedPairs, setAllowedPairs] = useState(['EUR/USD', 'GBP/USD']);
  const [tierDisplayName, setTierDisplayName] = useState('Basic');
  const [performance, setPerformance] = useState(null);
  const [accountBalance, setAccountBalance] = useState(10000);
  const [expandedId, setExpandedId] = useState(null);
  const [chartSymbol, setChartSymbol] = useState('EUR/USD');
  const [chartError, setChartError] = useState(null);
  const isAdminAccess = hasAdminUnlimitedAccess(subscription, user);

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
    setSignals((initialSignals || []).filter(isInsightsSignal));
  }, [initialSignals]);

  useEffect(() => {
    if (!isAuthenticated) return undefined;

    const socket = getSharedSocket();

    // Dashboard updates exclusively from TradingView webhook fan-out — no signal polling.
    socket.on('signal:update', newSignal => {
      if (!isInsightsSignal(newSignal)) return;
      setSignals(prev => [newSignal, ...prev.filter(s => String(s._id) !== String(newSignal._id))].slice(0, tierLimits.maxSignals || 50));
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

  const visibleSignals = useMemo(() => signals.filter(isInsightsSignal), [signals]);

  const hasAccess = isActiveSubscription(subscription) || isAdminAccess;
  const tierKey = subscription?.tier || 'basic';
  const planLabel = getPlanDisplayLabel(
    subscription,
    user,
    tierDisplayName || TIER_LABELS[tierKey] || tierKey
  );
  const statusLabel = getStatusDisplayLabel(subscription, user);
  const expiryLabel = getExpiryDisplayLabel(subscription, user, formatShortDate);
  const remainingLabel = getRemainingDaysDisplay(subscription, user);

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
          <p>{subscriptionBannerCopy(subscription)}</p>
        </div>
      )}

      <div className="subscription-status-card">
        {hasAccess ? (
          <>
            <div className="subscription-status-header">
              <h3>Current Plan</h3>
              <span className={`admin-pill ${isAdminAccess ? 'status-unlimited' : 'status-active'}`}>
                {statusLabel}
              </span>
            </div>
            <dl className="admin-meta-grid">
              <div className="admin-meta-item">
                <dt>Plan</dt>
                <dd>{planLabel}</dd>
              </div>
              {!isAdminAccess && (
                <div className="admin-meta-item">
                  <dt>Activation Date</dt>
                  <dd>{formatShortDate(subscription?.startDate || subscription?.updatedAt)}</dd>
                </div>
              )}
              <div className="admin-meta-item">
                <dt>Expires</dt>
                <dd>{expiryLabel}</dd>
              </div>
              <div className="admin-meta-item">
                <dt>{isAdminAccess ? 'Access' : 'Remaining Days'}</dt>
                <dd>{remainingLabel}</dd>
              </div>
            </dl>
          </>
        ) : subscription?.status === 'pending' ? (
          <>
            <div className="subscription-status-header">
              <h3>Subscription</h3>
              <span className="admin-pill status-pending">Awaiting Verification</span>
            </div>
            <p className="admin-table-meta">
              After you pay via M-Pesa Till and submit your code on Pricing, a Super Admin will activate
              your plan.
            </p>
          </>
        ) : (
          <>
            <div className="subscription-status-header">
              <h3>Subscription</h3>
              <span className="admin-pill status-inactive">
                {subscription?.status === 'expired' ? 'Subscription Expired' : subscription?.status || 'Inactive'}
              </span>
            </div>
            <p className="admin-table-meta">Renew on Pricing to restore access to live alerts.</p>
          </>
        )}
      </div>

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
          {isAdminAccess ? (
            <>
              <strong>{planLabel}</strong> · Unlimited Access · {allowedPairs.length} pairs ·{' '}
              {(tierLimits.timeframes || ['1h']).join(', ')} timeframes
            </>
          ) : (
            <>
              <strong>{planLabel}</strong> plan · {allowedPairs.length} pairs ·{' '}
              {(tierLimits.timeframes || ['1h']).join(', ')} timeframes · {tierLimits.historyDays || 7}-day
              history
            </>
          )}
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
            enableSmcOverlays={Boolean(tierLimits.smartMoneyConcepts)}
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
        {visibleSignals.length === 0 ? (
          <div className="signal-empty">No TradingView alerts yet. Attach your Pine script to any chart and create a webhook alert.</div>
        ) : (
          visibleSignals.map(signal => {
            const signalId = signal._id || signal.timestamp;
            const expanded = expandedId === signalId;
            const strategy = formatStrategyName(signal);
            const notesClean =
              signal.notes && !/pipeline\s*score|premium\s*smc\s*pipeline|threshold\s*\d+\s*%/i.test(String(signal.notes))
                ? signal.notes
                : null;

            return (
              <div key={signalId} className="signal-item" onClick={() => setChartSymbol(signal.symbol)}>
                <div className="signal-header">
                  <span>{signal.symbol}</span>
                  <span className="pattern-badge">{strategy}</span>
                  <OutcomeBadge outcome={signal.outcome} tradeStatus={signal.tradeStatus} />
                  <strong>{String(signal.direction || '').toUpperCase()}</strong>
                </div>
                <div className="signal-row signal-meta-row">
                  <span>Status: {signalStatusLabel(signal)}</span>
                  <span>TF: {signal.timeframe || '—'}</span>
                  <span>Source: {formatSignalSource()}</span>
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
                    <small>Confidence: {(Number(signal.confidence) <= 1 ? Number(signal.confidence) * 100 : Number(signal.confidence)).toFixed(0)}%</small>
                  ) : (
                    <small>Confidence: upgrade to Pro</small>
                  )}
                  {tierLimits.newsFilter && signal.newsImpact && signal.newsImpact !== 'none' && (
                    <small className={`news-impact news-impact-${signal.newsImpact}`}>
                      News: {signal.newsFilter?.label || signal.newsImpact}
                    </small>
                  )}
                  {tierLimits.tradeManagementAlerts && signal.tradeManagement?.message && (
                    <small className="trade-mgmt-hint">{signal.tradeManagement.message}</small>
                  )}
                  {signal.outcomeR != null && <small>Result: {signal.outcomeR}R</small>}
                  {notesClean && <span>{notesClean}</span>}
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
                        symbol={signal.symbol}
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
            Auto Trading (Pro+): connect MT5 in Auto Trading. Premium Auto queues every entry; Pro Manual confirms
            via Execute on the Telegram alert (EA still independent of Telegram)
            {tierLimits.trailingStop ? ', trailing stop' : ''}
            {tierLimits.breakEvenAutomation ? ', break-even' : ''}
            {tierLimits.autoLotSizing
              ? ', and Premium auto lot sizing from your synced MT5 balance'
              : ' (fixed lot size — upgrade to Premium for auto lot sizing)'}
            .
          </p>
        )}
        {tierLimits.telegramAlerts && (
          <p className="telegram-hint">
            Telegram notifications are enabled for your {isAdminAccess ? planLabel : `${TIER_LABELS[tierKey] || tierDisplayName} plan`}.
          </p>
        )}
      </div>
    </div>
  );
}
