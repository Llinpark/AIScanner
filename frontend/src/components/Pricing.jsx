import { useState, useEffect } from 'react';
<<<<<<< HEAD
import { subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import Checkout from './Checkout';
import AuthForm from './AuthForm';

export default function Pricing({ onSubscriptionUpdated, onNavigateDashboard }) {
  const { isAuthenticated, user } = useAuth();
  const [tiers, setTiers] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedTier, setSelectedTier] = useState(null);
=======
import { api } from '../services/api';
import Checkout from './Checkout';

export default function Pricing() {
  const [tiers, setTiers] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedTier, setSelectedTier] = useState(null);
  const [username, setUsername] = useState('');
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
  const [showCheckout, setShowCheckout] = useState(false);

  useEffect(() => {
    const fetchTiers = async () => {
      try {
<<<<<<< HEAD
        const response = await subscriptionApi.getTiers();
=======
        const response = await api.get('/tiers');
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
        setTiers(response.data);
      } catch (error) {
        console.error('Failed to fetch tiers:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchTiers();
  }, []);

<<<<<<< HEAD
  const handleSelectTier = tierName => {
    if (!isAuthenticated) {
      alert('Please sign in or create an account first.');
=======
  const handleSelectTier = (tierName) => {
    if (!username.trim()) {
      alert('Please enter your username first');
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
      return;
    }
    setSelectedTier(tierName);
    setShowCheckout(true);
  };

  if (loading) {
<<<<<<< HEAD
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
=======
    return <div className="pricing-container"><p>Loading pricing...</p></div>;
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
  }

  return (
    <div className="pricing-container">
      <div className="pricing-header">
        <img className="pricing-logo" src="/logo-1.png" alt="KachingFx" />
        <h1>Choose Your Trading Plan</h1>
<<<<<<< HEAD
        <p>
          Signed in as <strong>{user.displayName || user.email}</strong>. Complete payment to unlock live alerts.
        </p>
=======
        <p>Get started with KachingScanner and receive real-time trading signals</p>
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
      </div>

      {!showCheckout ? (
        <>
<<<<<<< HEAD
=======
          <div className="username-input">
            <input
              type="text"
              placeholder="Enter your username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
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
<<<<<<< HEAD
                  <button type="button" className={`btn-subscribe btn-${key}`} onClick={() => handleSelectTier(key)}>
                    <span className="btn-subscribe-label">Get {tier.name}</span>
                    <span className="btn-subscribe-arrow" aria-hidden="true">
                      →
                    </span>
=======
                  <button
                    type="button"
                    className={`btn-subscribe btn-${key}`}
                    onClick={() => handleSelectTier(key)}
                  >
                    <span className="btn-subscribe-label">Get {tier.name}</span>
                    <span className="btn-subscribe-arrow" aria-hidden="true">→</span>
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="pricing-footer">
<<<<<<< HEAD
            <p>All plans include a 7-day free trial. After payment, open TradingView for accurate alerts.</p>
=======
            <p>💡 All plans include a 7-day free trial</p>
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
          </div>
        </>
      ) : (
        <Checkout
<<<<<<< HEAD
          tier={selectedTier}
          tierData={tiers[selectedTier]}
          onBack={() => setShowCheckout(false)}
          onSubscriptionUpdated={onSubscriptionUpdated}
          onNavigateDashboard={onNavigateDashboard}
=======
          username={username}
          tier={selectedTier}
          tierData={tiers[selectedTier]}
          onBack={() => setShowCheckout(false)}
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
        />
      )}
    </div>
  );
}
