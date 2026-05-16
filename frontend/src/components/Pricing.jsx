import { useState, useEffect } from 'react';
import { api } from '../services/api';
import Checkout from './Checkout';

export default function Pricing() {
  const [tiers, setTiers] = useState({});
  const [loading, setLoading] = useState(true);
  const [selectedTier, setSelectedTier] = useState(null);
  const [username, setUsername] = useState('');
  const [showCheckout, setShowCheckout] = useState(false);

  useEffect(() => {
    const fetchTiers = async () => {
      try {
        const response = await api.get('/tiers');
        setTiers(response.data);
      } catch (error) {
        console.error('Failed to fetch tiers:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchTiers();
  }, []);

  const handleSelectTier = (tierName) => {
    if (!username.trim()) {
      alert('Please enter your username first');
      return;
    }
    setSelectedTier(tierName);
    setShowCheckout(true);
  };

  if (loading) {
    return <div className="pricing-container"><p>Loading pricing...</p></div>;
  }

  return (
    <div className="pricing-container">
      <div className="pricing-header">
        <img className="pricing-logo" src="/logo-1.png" alt="KachingFx" />
        <h1>Choose Your Trading Plan</h1>
        <p>Get started with KachingScanner and receive real-time trading signals</p>
      </div>

      {!showCheckout ? (
        <>
          <div className="username-input">
            <input
              type="text"
              placeholder="Enter your username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

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
                  <button
                    type="button"
                    className={`btn-subscribe btn-${key}`}
                    onClick={() => handleSelectTier(key)}
                  >
                    <span className="btn-subscribe-label">Get {tier.name}</span>
                    <span className="btn-subscribe-arrow" aria-hidden="true">→</span>
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="pricing-footer">
            <p>💡 All plans include a 7-day free trial</p>
          </div>
        </>
      ) : (
        <Checkout
          username={username}
          tier={selectedTier}
          tierData={tiers[selectedTier]}
          onBack={() => setShowCheckout(false)}
        />
      )}
    </div>
  );
}
