import { useState } from 'react';
import { api } from '../services/api';

export default function Checkout({ username, tier, tierData, onBack }) {
  const [provider, setProvider] = useState('mock'); // 'mock', 'mpesa', 'paypal'
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [paymentState, setPaymentState] = useState('pending'); // 'pending', 'confirmed', 'error'
  const [mockPaymentId, setMockPaymentId] = useState('');
  const [error, setError] = useState('');

  const handleInitiatePayment = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const payload = {
        username,
        tier,
        provider,
        phone: provider === 'mpesa' ? phone : undefined,
        email: `${username}@kachingscanner.local`
      };

      const response = await api.post('/subscribe', payload);

      if (provider === 'mock') {
        setMockPaymentId(response.data.mockPaymentId);
        setPaymentState('initiated');
      } else if (provider === 'mpesa') {
        alert('STK push sent to ' + phone + '. Check your phone for the payment prompt.');
        setPaymentState('initiated');
      } else if (provider === 'paypal') {
        // In production, redirect to PayPal
        alert('Redirecting to PayPal...');
        // window.location.href = response.data.checkoutUrl;
        setPaymentState('initiated');
      }
    } catch (err) {
      setError('Payment initiation failed: ' + (err.response?.data?.message || err.message));
      setPaymentState('error');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmMockPayment = async () => {
    try {
      setLoading(true);
      const response = await api.post('/payments/mock/confirm', {
        username,
        paymentId: mockPaymentId,
        tier
      });

      setPaymentState('confirmed');
      alert('🎉 Subscription activated! You now have ' + tier + ' access.');
      onBack();
    } catch (err) {
      setError('Failed to confirm payment: ' + err.message);
      setPaymentState('error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="checkout-container">
      <button className="btn-back" onClick={onBack}>← Back</button>

      <div className="checkout-card">
        <h2>Complete Your Purchase</h2>
        <div className="order-summary">
          <p><strong>Plan:</strong> {tierData.name}</p>
          <p><strong>Price:</strong> KES {tierData.price}/month</p>
          <p><strong>Trial:</strong> 7 days free</p>
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
                    onChange={(e) => setProvider(e.target.value)}
                  />
                  Mock Payment (Test Mode)
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="provider"
                    value="mpesa"
                    checked={provider === 'mpesa'}
                    onChange={(e) => setProvider(e.target.value)}
                  />
                  M-Pesa
                </label>
                <label className="radio-option">
                  <input
                    type="radio"
                    name="provider"
                    value="paypal"
                    checked={provider === 'paypal'}
                    onChange={(e) => setProvider(e.target.value)}
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
                  onChange={(e) => setPhone(e.target.value)}
                  required
                />
              </div>
            )}

            {error && <div className="error-message">{error}</div>}

            <button type="submit" className="btn-proceed" disabled={loading}>
              {loading ? 'Processing...' : 'Proceed to Payment'}
            </button>
          </form>
        )}

        {paymentState === 'initiated' && provider === 'mock' && (
          <div className="mock-payment-flow">
            <div className="info-box">
              <h3>Mock Payment Initiated</h3>
              <p>Payment ID: <code>{mockPaymentId}</code></p>
              <p>In a real scenario, you would complete payment with your provider.</p>
              <p>For testing, click "Confirm Payment" below to activate your subscription.</p>
            </div>
            <button
              className="btn-confirm"
              onClick={handleConfirmMockPayment}
              disabled={loading}
            >
              {loading ? 'Confirming...' : 'Confirm Payment'}
            </button>
          </div>
        )}

        {paymentState === 'initiated' && provider === 'mpesa' && (
          <div className="mpesa-flow">
            <div className="info-box">
              <h3>M-Pesa Payment in Progress</h3>
              <p>An STK push has been sent to {phone}.</p>
              <p>Please check your phone and enter your M-Pesa PIN to complete the payment.</p>
              <p>You can close this window once you've entered your PIN.</p>
            </div>
          </div>
        )}

        {paymentState === 'initiated' && provider === 'paypal' && (
          <div className="paypal-flow">
            <div className="info-box">
              <h3>PayPal Payment in Progress</h3>
              <p>You will be redirected to PayPal to complete your payment.</p>
              <p>After payment, you'll return here and your subscription will be activated.</p>
            </div>
          </div>
        )}

        {paymentState === 'confirmed' && (
          <div className="success-message">
            <h3>✓ Payment Successful!</h3>
            <p>Your subscription has been activated.</p>
            <button className="btn-dashboard" onClick={onBack}>
              Go to Dashboard
            </button>
          </div>
        )}

        {paymentState === 'error' && (
          <div className="error-box">
            <h3>Payment Failed</h3>
            <p>{error}</p>
            <button className="btn-retry" onClick={() => setPaymentState('pending')}>
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
