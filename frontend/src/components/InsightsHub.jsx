import { lazy, Suspense, useEffect, useState } from 'react';
import { subscriptionApi } from '../services/api';
import SignalHistory from './insights/SignalHistory';
import TradeJournal from './insights/TradeJournal';

const AnalyticsDashboard = lazy(() => import('./insights/AnalyticsDashboard'));

const TABS = [
  { id: 'history', label: 'Signal History' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'journal', label: 'Trade Journal' }
];

export default function InsightsHub({ subscription, onNavigatePricing }) {
  const [activeTab, setActiveTab] = useState('history');
  const [tierLimits, setTierLimits] = useState({ historyDays: 7 });
  const [journalPrefill, setJournalPrefill] = useState(null);

  useEffect(() => {
    subscriptionApi
      .getMe()
      .then(res => {
        if (res.data.tierFeatures) setTierLimits(res.data.tierFeatures);
      })
      .catch(() => {});
  }, [subscription]);

  const handleAddToJournal = signal => {
    setJournalPrefill(signal);
    setActiveTab('journal');
  };

  return (
    <div className="dashboard-card insights-hub">
      <h2>Insights</h2>
      <p className="insights-intro">
        TradingView signal history, performance analytics, and your trade journal — distribution metrics, not live
        scanner scores.
      </p>

      <div className="insights-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'history' && (
        <SignalHistory tierLimits={tierLimits} onAddToJournal={handleAddToJournal} />
      )}
      {activeTab === 'analytics' && (
        <Suspense fallback={<div className="loading-state">Loading analytics…</div>}>
          <AnalyticsDashboard tierLimits={tierLimits} onNavigatePricing={onNavigatePricing} />
        </Suspense>
      )}
      {activeTab === 'journal' && (
        <TradeJournal
          tierLimits={tierLimits}
          prefill={journalPrefill}
          onPrefillConsumed={() => setJournalPrefill(null)}
          onNavigatePricing={onNavigatePricing}
        />
      )}
    </div>
  );
}
