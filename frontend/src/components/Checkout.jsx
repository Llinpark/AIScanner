import { useState } from 'react';
import { subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function Checkout({ tier, tierData, onBack, onSubscriptionUpdated, onNavigateDashboard }) {
  const { user, updateUser } = useAuth();
  const [provider, setProvider] = useState('mock');
  const [phone, setPhone] = useState(user?.phone || '');
  const [loading, setLoading] = useState(false);
  const [paymentState, setPaymentState] = useState('pending');
  const [mockPaymentId, setMockPaymentId] = useState('');
  const [error, setError] = useState('');

  const handleInitiatePayment = async e => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await subscriptionApi.subscribe({
        tier,
        provider,
        phone: provider === 'mpesa' ? phone : undefined
      });

      if (provider === 'mock') {
        setMockPaymentId(response.data.mockPaymentId);
        setPaymentState('initiated');
      } else if (provider === 'mpesa') {
        alert(`STK push sent to ${phone}. Check your phone for the payment prompt.`);
        setPaymentState('initiated');
      } else if (provider === 'paypal') {
        alert('Redirecting to PayPal…');
        setPaymentState('initiated');
      }
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Payment initiation failed.');
      setPaymentState('error');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmMockPayment = async () => {
    try {
      setLoading(true);
      const response = await subscriptionApi.confirmMockPayment({
        paymentId: mockPaymentId,
        tier
      });

      updateUser(response.data.user);
      await onSubscriptionUpdated?.();
      setPaymentState('confirmed');
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to confirm payment.');
      setPaymentState('error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="checkout-container">
      <button type="button" className="btn-back" onClick={onBack}>
        ← Back
      </button>

      <div className="checkout-card">
        <h2>Complete Your Purchase</h2>
        <div className="order-summary">
          <p>
            <strong>Plan:</strong> {tierData.name}
          </p>
          <p>
            <strong>Price:</strong> KES {tierData.price}/month
          </p>
        </div>

        {paymentState === 'pending' && (
          <form onSubmit={handleInitiatePayment}>
            <div className="form-group">
              <label>Payment Method</label>
              <div className="payment-options">
                <label className="radio-option">
                  <input
                    type="radio"
                    name="provider"
                    value="mock"
                    checked={provider === 'mock'}
                    onChange={e => setProvider(e.target.value)}
                  />
                  Mock Payment (Test Mode)
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="provider"
                    value="mpesa"
                    checked={provider === 'mpesa'}
                    onChange={e => setProvider(e.target.value)}
                  />
                  M-Pesa
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="provider"
                    value="paypal"
                    checked={provider === 'paypal'}
                    onChange={e => setProvider(e.target.value)}
                  />
                  PayPal / Card
                </label>
              </div>
            </div>

            {provider === 'mpesa' && (
              <div className="form-group">
                <label>Phone Number (for M-Pesa)</label>
                <input
                  type="tel"
                  placeholder="+254712345678"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  required
                />
              </div>
            )}

            {error && <div className="error-message">{error}</div>}

            <button type="submit" className="btn-proceed" disabled={loading}>
              {loading ? 'Processing…' : 'Proceed to Payment'}
            </button>
          </form>
        )}

        {paymentState === 'initiated' && provider === 'mock' && (
          <div className="mock-payment-flow">
            <div className="info-box">
              <h3>Mock Payment Initiated</h3>
              <p>
                Payment ID: <code>{mockPaymentId}</code>
              </p>
              <p>For testing, click Confirm Payment below to activate your subscription.</p>
            </div>
            <button type="button" className="btn-confirm" onClick={handleConfirmMockPayment} disabled={loading}>
              {loading ? 'Confirming…' : 'Confirm Payment'}
            </button>
          </div>
        )}

        {paymentState === 'initiated' && provider === 'mpesa' && (
          <div className="mpesa-flow">
            <div className="info-box">
              <h3>M-Pesa Payment in Progress</h3>
              <p>An STK push has been sent to {phone}.</p>
              <p>Enter your M-Pesa PIN on your phone to complete payment.</p>
            </div>
          </div>
        )}

        {paymentState === 'initiated' && provider === 'paypal' && (
          <div className="paypal-flow">
            <div className="info-box">
              <h3>PayPal Payment in Progress</h3>
              <p>Complete payment on PayPal. Your subscription activates automatically.</p>
            </div>
          </div>
        )}

        {paymentState === 'confirmed' && (
          <div className="success-message">
            <h3>Payment successful</h3>
            <p>
              Your subscription is active. Open TradingView and follow the setup guide for Kaching Entry, Kaching Stop Loss, and Kaching
              Take Profit alerts.
            </p>
            <button type="button" className="btn-dashboard" onClick={onNavigateDashboard || onBack}>
              Go to TradingView Setup
            </button>
          </div>
        )}

        {paymentState === 'error' && (
          <div className="error-box">
            <h3>Payment Failed</h3>
            <p>{error}</p>
            <button type="button" className="btn-retry" onClick={() => setPaymentState('pending')}>
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
