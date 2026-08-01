import { useState, useEffect } from 'react';
import { subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';
import ManualMpesaCheckout from './ManualMpesaCheckout';
import { PRICING_FAQS } from '../seo/pageMeta';
import {
  getPlanDisplayLabel,
  getStatusDisplayLabel,
  hasAdminUnlimitedAccess
} from '../utils/subscriptionDisplay';

function isActiveSubscription(subscription) {
  if (!subscription) return false;
  return subscription.status === 'active';
}

function subscriptionStatusLabel(subscription) {
  const status = subscription?.status || 'pending';
  if (status === 'active') return 'Active';
  if (status === 'pending') return 'Awaiting Verification';
  if (status === 'expired') return 'Subscription Expired';
  if (status === 'cancelled') return 'Cancelled';
  return status;
}

function getTierPrice(tier, billingCycle) {
  const pricing = tier?.pricing?.[billingCycle] || tier?.pricing?.monthly;
  if (pricing) {
    return pricing;
  }
  return {
    price: tier?.price || 0,
    priceCents: tier?.priceCents || 0,
    periodLabel: billingCycle === 'yearly' ? 'year' : 'month'
  };
}

export default function Pricing({
  onSubscriptionUpdated,
  onNavigateDashboard,
  onNavigateReferrals,
  onSignIn
}) {
  const { isAuthenticated, user, subscription } = useAuth();
  const [tiers, setTiers] = useState({});
  const [paymentMethods, setPaymentMethods] = useState({});
  const [loading, setLoading] = useState(true);
  const [billingCycle, setBillingCycle] = useState('monthly');
  const [selectedTier, setSelectedTier] = useState(null);
  const [showCheckout, setShowCheckout] = useState(false);

  useEffect(() => {
    const fetchTiers = async () => {
      try {
        const response = await subscriptionApi.getTiers();
        setTiers(response.data.tiers || response.data);
        setPaymentMethods(response.data.paymentMethods || {});
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
      onSignIn?.();
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

  const currentTier = subscription?.tier || 'basic';
  const isAdminAccess = hasAdminUnlimitedAccess(subscription, user);
  const hasAccess = isAuthenticated && (isActiveSubscription(subscription) || isAdminAccess);
  const periodSuffix = billingCycle === 'yearly' ? '/year' : '/month';
  const adminPlanLabel = getPlanDisplayLabel(subscription, user);

  return (
    <div className="pricing-container">
      <div className="pricing-header">
        <h1>Pricing &amp; Plans</h1>
        <p>
          {isAuthenticated ? (
            <>
              Signed in as <strong>{user.displayName || user.email}</strong>.
              {isAdminAccess ? (
                <>
                  {' '}
                  Plan: <strong>{adminPlanLabel}</strong> · Status:{' '}
                  <strong>{getStatusDisplayLabel(subscription, user)}</strong> · Expires:{' '}
                  <strong>Never</strong>.
                </>
              ) : hasAccess ? (
                <>
                  {' '}
                  Your <strong>{tiers[currentTier]?.name || currentTier}</strong> plan is active.
                </>
              ) : (
                <>
                  {' '}
                  Status: <strong>{subscriptionStatusLabel(subscription)}</strong>. Pay via M-Pesa
                  Till to unlock live alerts.
                </>
              )}
            </>
          ) : (
            <>Browse plans below. Login or register when you are ready to subscribe.</>
          )}
        </p>
        {!showCheckout && (
          <div className="billing-toggle" role="group" aria-label="Billing cycle">
            <button
              type="button"
              className={`billing-toggle-btn ${billingCycle === 'monthly' ? 'active' : ''}`}
              onClick={() => setBillingCycle('monthly')}
            >
              Monthly
            </button>
            <button
              type="button"
              className={`billing-toggle-btn ${billingCycle === 'yearly' ? 'active' : ''}`}
              onClick={() => setBillingCycle('yearly')}
            >
              Yearly <span className="billing-save-badge">Save 5%</span>
            </button>
          </div>
        )}
      </div>

      {!showCheckout ? (
        <>
          <div className="pricing-tiers">
            {Object.entries(tiers).map(([key, tier]) => {
              // Admins use role access — never mark Basic/Pro/Premium as "Current Plan".
              const isCurrent = !isAdminAccess && key === currentTier && hasAccess;
              const limits = tier.limits || {};
              const pricing = getTierPrice(tier, billingCycle);

              return (
                <div key={key} className={`pricing-card ${key} ${isCurrent ? 'current-plan' : ''}`}>
                  {key === 'professional' && <span className="tier-popular-badge">Most Popular</span>}
                  {key === 'premium' && <span className="tier-popular-badge tier-best">Best Value</span>}
                  {isCurrent && <span className="tier-current-badge">Current Plan</span>}
                  <div className="card-header">
                    <h2>{tier.name}</h2>
                    <p className="description">{tier.description}</p>
                    <div className="price">
                      <span className="amount">KES {pricing.price.toLocaleString()}</span>
                      <span className="period">{periodSuffix}</span>
                    </div>
                    {billingCycle === 'yearly' && tier.pricing?.monthly?.price ? (
                      <p className="tier-meta">
                        vs KES {(tier.pricing.monthly.price * 12).toLocaleString()}/year billed monthly
                      </p>
                    ) : null}
                    {limits.currencyPairs ? (
                      <p className="tier-meta">
                        {limits.currencyPairs.length} supported markets
                        {' · '}
                        {limits.timeframes?.length || 1} timeframe
                        {(limits.timeframes?.length || 0) !== 1 ? 's' : ''}
                        {limits.historyDays ? ` · ${limits.historyDays}-day history` : ''}
                      </p>
                    ) : null}
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
                      <button
                        type="button"
                        className={`btn-subscribe btn-${key}`}
                        onClick={() => handleSelectTier(key)}
                      >
                        <span className="btn-subscribe-label">
                          {hasAccess && key !== currentTier
                            ? `Switch to ${tier.name}`
                            : `Get ${tier.name}`}
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

          <section className="pricing-payment-info" aria-label="Direct payment details">
            <p className="pricing-payment-kicker">Direct payment</p>
            <p className="pricing-payment-intro">Pay via M-Pesa Till</p>
            <ul className="pricing-payment-details">
              <li>
                <span className="pricing-payment-label">M-Pesa Till</span>
                <span className="pricing-payment-value">5337170</span>
              </li>
              <li>
                <span className="pricing-payment-label">Account name</span>
                <span className="pricing-payment-value">KachingFx Official</span>
              </li>
              <li>
                <span className="pricing-payment-label">Binance ID</span>
                <span className="pricing-payment-value">484947783</span>
              </li>
            </ul>
          </section>

          <section className="pricing-faq" aria-labelledby="pricing-faq-title">
            <h2 id="pricing-faq-title">Frequently asked questions</h2>
            <div className="pricing-faq-list">
              {PRICING_FAQS.map(item => (
                <details key={item.question} className="pricing-faq-item">
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </section>

          <div className="pricing-footer">
            <p>After payment, open TradingView for accurate alerts.</p>
            {onNavigateReferrals && (
              <div className="refer-earn-cta refer-earn-cta-pricing">
                <div className="refer-earn-cta-copy">
                  <span className="refer-earn-badge">Refer &amp; Earn</span>
                  <p>Invite traders and earn commission on their plans.</p>
                </div>
                <button type="button" className="btn-fetch" onClick={onNavigateReferrals}>
                  Refer &amp; Earn
                </button>
              </div>
            )}
          </div>
        </>
      ) : (
        <ManualMpesaCheckout
          tier={selectedTier}
          tierData={tiers[selectedTier]}
          billingCycle={billingCycle}
          paymentMethods={paymentMethods}
          onBack={() => setShowCheckout(false)}
          onSubscriptionUpdated={onSubscriptionUpdated}
          onNavigateDashboard={onNavigateDashboard}
        />
      )}
    </div>
  );
}
