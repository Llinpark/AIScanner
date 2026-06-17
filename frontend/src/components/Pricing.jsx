import { useState, useEffect } from 'react';
import { subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import Checkout from './Checkout';
import AuthForm from './AuthForm';

export default function Pricing({ onSubscriptionUpdated, onNavigateDashboard }) {
  const { isAuthenticated, user } = useAuth();
  const [tiers, setTiers] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedTier, setSelectedTier] = useState(null);
  const [showCheckout, setShowCheckout] = useState(false);

  useEffect(() => {
    const fetchTiers = async () => {
      try {
        const response = await subscriptionApi.getTiers();
        setTiers(response.data);
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
          <p>Create an account, subscribe, then open TradingView for live Entry, SL, and TP alerts.</p>
        </div>
        <AuthForm initialMode="register" onSuccess={() => {}} />
      </div>
    );
  }

  return (
    <div className="pricing-container">
      <div className="pricing-header">
        <img className="pricing-logo" src="/logo-1.png" alt="KachingFx" />
        <h1>Choose Your Trading Plan</h1>
        <p>
          Signed in as <strong>{user.displayName || user.email}</strong>. Complete payment to unlock live alerts.
        </p>
      </div>

      {!showCheckout ? (
        <>
          <div className="pricing-tiers">
            {Object.entries(tiers).map(([key, tier]) => (
              <div key={key} className={`pricing-card ${key}`}>
                {key === 'professional' && <span className="tier-popular-badge">Most Popular</span>}
                {key === 'premium' && <span className="tier-popular-badge tier-best">Best Value</span>}
                <div className="card-header">
                  <h2>{tier.name}</h2>
                  <p className="description">{tier.description}</p>
                  <div className="price">
                    <span className="amount">KES {tier.price}</span>
                    <span className="period">/month</span>
                  </div>
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
                  <button type="button" className={`btn-subscribe btn-${key}`} onClick={() => handleSelectTier(key)}>
                    <span className="btn-subscribe-label">Get {tier.name}</span>
                    <span className="btn-subscribe-arrow" aria-hidden="true">
                      →
                    </span>
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="pricing-footer">
            <p>All plans include a 7-day free trial. After payment, open TradingView for accurate alerts.</p>
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
