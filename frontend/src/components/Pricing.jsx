import { useState, useEffect } from 'react';
import { subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import Checkout from './Checkout';
import AuthForm from './AuthForm';

const TIER_COLUMNS = [
  { key: 'basic', label: 'Basic' },
  { key: 'professional', label: 'Pro' },
  { key: 'premium', label: 'Premium' }
];

function isActiveSubscription(subscription) {
  if (!subscription) return false;
  return subscription.status === 'active';
}

function renderMatrixCell(value) {
  if (value === true) return <span className="matrix-yes">✓</span>;
  if (value === false) return <span className="matrix-no">✗</span>;
  return <span className="matrix-text">{value}</span>;
}

export default function Pricing({ onSubscriptionUpdated, onNavigateDashboard }) {
  const { isAuthenticated, user, subscription } = useAuth();
  const [tiers, setTiers] = useState({});
  const [featureMatrix, setFeatureMatrix] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTier, setSelectedTier] = useState(null);
  const [showCheckout, setShowCheckout] = useState(false);

  useEffect(() => {
    const fetchTiers = async () => {
      try {
        const response = await subscriptionApi.getTiers();
        setTiers(response.data.tiers || response.data);
        setFeatureMatrix(response.data.featureMatrix || []);
      } catch (error) {
        console.error('Failed to fetch tiers:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchTiers();
  }, []);

  const handleSelectTier = tierName => {
    if (!isAuthenticated) {
      alert('Please sign in or create an account first.');
      return;
    }
    setSelectedTier(tierName);
    setShowCheckout(true);
  };

  if (loading) {
    return (
      <div className="pricing-container">
        <p>Loading pricing…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="pricing-container">
        <div className="pricing-header">
          <img className="pricing-logo" src="/logo-1.png" alt="KachingFx" />
          <h1>Choose Your Trading Plan</h1>
          <p>Create an account, subscribe, then open TradingView for live Kaching Entry, Kaching Stop Loss, and Kaching Take Profit alerts.</p>
        </div>
        <AuthForm initialMode="register" onSuccess={() => {}} />
      </div>
    );
  }

  const currentTier = subscription?.tier || 'basic';
  const hasAccess = isActiveSubscription(subscription);

  return (
    <div className="pricing-container">
      <div className="pricing-header">
        <img className="pricing-logo" src="/logo-1.png" alt="KachingFx" />
        <h1>Choose Your Trading Plan</h1>
        <p>
          Signed in as <strong>{user.displayName || user.email}</strong>.
          {hasAccess ? (
            <>
              {' '}
              Your <strong>{tiers[currentTier]?.name || currentTier}</strong> plan is active.
            </>
          ) : (
            <> Complete payment to unlock live alerts.</>
          )}
        </p>
      </div>

      {!showCheckout ? (
        <>
          <div className="pricing-tiers">
            {Object.entries(tiers).map(([key, tier]) => {
              const isCurrent = key === currentTier && hasAccess;
              const limits = tier.limits || {};

              return (
                <div key={key} className={`pricing-card ${key} ${isCurrent ? 'current-plan' : ''}`}>
                  {key === 'professional' && <span className="tier-popular-badge">Most Popular</span>}
                  {key === 'premium' && <span className="tier-popular-badge tier-best">Best Value</span>}
                  {isCurrent && <span className="tier-current-badge">Current Plan</span>}
                  <div className="card-header">
                    <h2>{tier.name}</h2>
                    <p className="description">{tier.description}</p>
                    <div className="price">
                      <span className="amount">KES {tier.price.toLocaleString()}</span>
                      <span className="period">/month</span>
                    </div>
                    {limits.currencyPairs && (
                      <p className="tier-meta">
                        {limits.currencyPairs.length} pairs · {limits.timeframes?.length || 1} timeframe
                        {(limits.timeframes?.length || 0) !== 1 ? 's' : ''}
                      </p>
                    )}
                  </div>

                  <div className="card-body">
                    <ul className="features-list">
                      {tier.features.map((feature, idx) => (
                        <li key={idx}>
                          <span className="check">✓</span> {feature}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="card-footer">
                    {isCurrent ? (
                      <button type="button" className={`btn-subscribe btn-${key}`} disabled>
                        <span className="btn-subscribe-label">Current Plan</span>
                      </button>
                    ) : (
                      <button type="button" className={`btn-subscribe btn-${key}`} onClick={() => handleSelectTier(key)}>
                        <span className="btn-subscribe-label">
                          {hasAccess && key !== currentTier ? `Switch to ${tier.name}` : `Get ${tier.name}`}
                        </span>
                        <span className="btn-subscribe-arrow" aria-hidden="true">
                          →
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {featureMatrix.length > 0 && (
            <div className="feature-comparison">
              <h2>Feature Comparison</h2>
              <div className="comparison-table-wrap">
                <table className="comparison-table">
                  <thead>
                    <tr>
                      <th>Feature</th>
                      {TIER_COLUMNS.map(col => (
                        <th key={col.key}>{col.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {featureMatrix.map(row => (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        {TIER_COLUMNS.map(col => (
                          <td key={col.key}>{renderMatrixCell(row[col.key])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="pricing-footer">
            <p>After payment, open TradingView for accurate alerts.</p>
          </div>
        </>
      ) : (
        <Checkout
          tier={selectedTier}
          tierData={tiers[selectedTier]}
          onBack={() => setShowCheckout(false)}
          onSubscriptionUpdated={onSubscriptionUpdated}
          onNavigateDashboard={onNavigateDashboard}
        />
      )}
    </div>
  );
}
