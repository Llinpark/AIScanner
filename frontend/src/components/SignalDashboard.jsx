import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

// Feature access by tier
const FEATURE_ACCESS = {
  basic: {
    maxSignals: 50,
    historyDays: 7,
    showConfidence: false,
    showIndicators: false,
    apiAccess: false,
    exportSignals: false
  },
  professional: {
    maxSignals: 100,
    historyDays: 30,
    showConfidence: true,
    showIndicators: true,
    apiAccess: true,
    exportSignals: false
  },
  premium: {
    maxSignals: 500,
    historyDays: 90,
    showConfidence: true,
    showIndicators: true,
    apiAccess: true,
    exportSignals: true
  }
};

export default function SignalDashboard({ initialSignals, username, subscription }) {
  const [signals, setSignals] = useState(initialSignals || []);
  const [tierFeatures, setTierFeatures] = useState(FEATURE_ACCESS.basic);

  useEffect(() => {
    if (subscription) {
      const tier = subscription.tier || 'basic';
      setTierFeatures(FEATURE_ACCESS[tier] || FEATURE_ACCESS.basic);
    }
  }, [subscription]);

  useEffect(() => {
    const socket = io(SOCKET_URL);

    socket.on('signal:update', newSignal => {
      setSignals(prev => {
        const updated = [newSignal, ...prev].slice(0, tierFeatures.maxSignals);
        return updated;
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [tierFeatures.maxSignals]);

  const renderFeatureLock = (feature) => {
    return (
      <div className="feature-lock">
        🔒 Available in Professional / Premium plans
      </div>
    );
  };

  return (
    <div className="dashboard-card">
      <h2>Recent Trade Signals</h2>
      
      {subscription?.status !== 'active' && (
        <div className="subscription-banner">
          <p>⚠️ Your subscription is {subscription?.status || 'inactive'}. 
             <a href="#" onClick={() => window.location.hash = 'pricing'}> Upgrade now</a> to unlock all features!</p>
        </div>
      )}

      <div className="signal-list">
        {signals.length === 0 ? (
          <div className="signal-empty">No signals available.</div>
        ) : (
          signals.map(signal => (
            <div key={signal._id || signal.timestamp} className="signal-item">
              <div className="signal-header">
                <span>{signal.symbol}</span>
                {signal.pattern && (
                  <span className="pattern-badge">{signal.patternLabel || signal.pattern}</span>
                )}
                <strong>{signal.direction.toUpperCase()}</strong>
              </div>
              <div className="signal-row">
                <span>Entry: {signal.entry.toFixed(5)}</span>
                <span>SL: {signal.stop_loss.toFixed(5)}</span>
              </div>
              <div className="signal-row">
                <span>TP1: {signal.take_profit_1.toFixed(5)}</span>
                <span>TP2: {signal.take_profit_2.toFixed(5)}</span>
                <span>TP3: {signal.take_profit_3.toFixed(5)}</span>
              </div>
              <div className="signal-footer">
                {tierFeatures.showConfidence ? (
                  <small>Confidence: {(signal.confidence * 100).toFixed(0)}%</small>
                ) : (
                  <small>Confidence: [Basic tier - upgrade to view]</small>
                )}
                <span>{signal.notes}</span>
              </div>

              {tierFeatures.showIndicators && (
                <div className="signal-indicators">
                  <small>📊 Indicators available (Advanced plan)</small>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div className="dashboard-footer">
        <div className="tier-info">
          <strong>Current Plan:</strong> {subscription?.tier?.toUpperCase() || 'BASIC'}
        </div>
        {!tierFeatures.apiAccess && renderFeatureLock('API Access')}
        {!tierFeatures.exportSignals && renderFeatureLock('Export Signals')}
      </div>
    </div>
  );
}
