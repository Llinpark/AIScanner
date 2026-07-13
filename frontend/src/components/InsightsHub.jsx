import { useEffect, useState } from 'react';
import { subscriptionApi } from '../services/api';
import SignalHistory from './insights/SignalHistory';
import AnalyticsDashboard from './insights/AnalyticsDashboard';
import TradeJournal from './insights/TradeJournal';

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
        Signal history, real win-rate analytics, risk analysis, AI explanations, and your trade journal.
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
        <AnalyticsDashboard tierLimits={tierLimits} onNavigatePricing={onNavigatePricing} />
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
