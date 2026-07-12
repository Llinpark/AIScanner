import { useState, useEffect, useRef } from 'react';
import { subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function Checkout({ tier, tierData, onBack, onSubscriptionUpdated, onNavigateDashboard }) {
  const { user, updateUser } = useAuth();
  const [provider, setProvider] = useState('mpesa');
  const [phone, setPhone] = useState(user?.phone || '');
  const [loading, setLoading] = useState(false);
  const [paymentState, setPaymentState] = useState('pending');
  const [mockPaymentId, setMockPaymentId] = useState('');
  const [checkoutRequestId, setCheckoutRequestId] = useState('');
  const [paypalOrderId, setPaypalOrderId] = useState('');
  const [isMockMode, setIsMockMode] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, []);

  const startMpesaPolling = requestId => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
    }

    pollRef.current = setInterval(async () => {
      try {
        const response = await subscriptionApi.getMpesaStatus(requestId);
        if (response.data.status === 'completed' || response.data.subscriptionActive) {
          clearInterval(pollRef.current);
          await onSubscriptionUpdated?.();
          setPaymentState('confirmed');
        } else if (response.data.status === 'failed') {
          clearInterval(pollRef.current);
          setError(response.data.failureReason || 'M-Pesa payment failed.');
          setPaymentState('error');
        }
      } catch {
        // Keep polling until timeout
      }
    }, 3000);

    setTimeout(() => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    }, 120000);
  };

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

      setIsMockMode(Boolean(response.data.mockMode));

      if (provider === 'mock') {
        setMockPaymentId(response.data.mockPaymentId);
        setPaymentState('initiated');
      } else if (provider === 'mpesa') {
        const requestId = response.data.checkoutRequestId || response.data.stkRequestId;
        setCheckoutRequestId(requestId);
        setPaymentState('initiated');
        if (!response.data.mockMode) {
          startMpesaPolling(requestId);
        }
      } else if (provider === 'paypal') {
        const orderId = response.data.checkoutId;
        setPaypalOrderId(orderId);

        if (response.data.mockMode) {
          setPaymentState('initiated');
        } else if (response.data.checkoutUrl) {
          window.location.href = response.data.checkoutUrl;
        } else {
          throw new Error('PayPal checkout URL not available');
        }
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

  const handleConfirmMpesaMock = async () => {
    try {
      setLoading(true);
      const response = await subscriptionApi.confirmMpesaMock({
        checkoutRequestId,
        tier
      });

      updateUser(response.data.user);
      await onSubscriptionUpdated?.();
      setPaymentState('confirmed');
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to confirm M-Pesa payment.');
      setPaymentState('error');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmPaypalMock = async () => {
    try {
      setLoading(true);
      const response = await subscriptionApi.confirmPaypalMock({
        orderId: paypalOrderId,
        tier
      });

      updateUser(response.data.user);
      await onSubscriptionUpdated?.();
      setPaymentState('confirmed');
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to confirm PayPal payment.');
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
          {provider === 'paypal' && (
            <p>
              <strong>PayPal/Card:</strong> USD {(tierData.priceCents / 100).toFixed(2)}/month
            </p>
          )}
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
                    value="mpesa"
                    checked={provider === 'mpesa'}
                    onChange={e => setProvider(e.target.value)}
                  />
                  M-Pesa (Till 5337170)
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
              </div>
            </div>

            {provider === 'mpesa' && (
              <div className="form-group">
                <label>Phone Number (M-Pesa)</label>
                <input
                  type="tel"
                  placeholder="254712345678 or 0712345678"
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  required
                />
                <small>Payment will be sent to Till number 5337170</small>
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
              <p>Enter your M-Pesa PIN on your phone to pay Till <strong>5337170</strong>.</p>
              {!isMockMode && <p>Waiting for payment confirmation…</p>}
              {isMockMode && (
                <p>
                  <em>Mock mode — M-Pesa credentials not configured. Click below to simulate payment.</em>
                </p>
              )}
            </div>
            {isMockMode && (
              <button type="button" className="btn-confirm" onClick={handleConfirmMpesaMock} disabled={loading}>
                {loading ? 'Confirming…' : 'Simulate M-Pesa Payment'}
              </button>
            )}
          </div>
        )}

        {paymentState === 'initiated' && provider === 'paypal' && (
          <div className="paypal-flow">
            <div className="info-box">
              <h3>PayPal Payment</h3>
              {isMockMode ? (
                <>
                  <p>
                    <em>Mock mode — PayPal credentials not configured.</em>
                  </p>
                  <p>Click below to simulate a successful PayPal/card payment.</p>
                </>
              ) : (
                <p>Complete payment on PayPal. Your subscription activates automatically.</p>
              )}
            </div>
            {isMockMode && (
              <button type="button" className="btn-confirm" onClick={handleConfirmPaypalMock} disabled={loading}>
                {loading ? 'Confirming…' : 'Simulate PayPal Payment'}
              </button>
            )}
          </div>
        )}

        {paymentState === 'confirmed' && (
          <div className="success-message">
            <h3>Payment successful</h3>
            <p>
              Your subscription is active. Open TradingView and follow the setup guide for Kaching Entry, Kaching SL,
              Kaching TP1, Kaching TP2, and Kaching TP3 alerts.
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
