import { useState, useEffect, useRef, useMemo } from 'react';
import { subscriptionApi } from '../services/api';
import { redirectToCheckout } from '../utils/safeRedirect';
import { useAuth } from '../context/AuthContext';

const PHONE_PROVIDERS = new Set(['mpesa']);
const LIVE_PROVIDERS = ['paypal'];
const DEV_EXTRA_PROVIDERS = ['mpesa', 'binance', 'mock'];

function normalizeCheckoutBillingCycle(cycle) {
  return cycle === 'yearly' ? 'yearly' : 'monthly';
}

export default function Checkout({
  tier,
  tierData,
  billingCycle: billingCycleProp = 'monthly',
  paymentMethods = {},
  onBack,
  onSubscriptionUpdated,
  onNavigateDashboard
}) {
  const billingCycle = normalizeCheckoutBillingCycle(billingCycleProp);
  const { user, updateUser } = useAuth();
  const mockPaymentsAllowed = Boolean(paymentMethods?.mockPaymentsAllowed);
  const availableProviders = useMemo(() => {
    // Live site: PayPal when configured (never mock).
    // Local/dev with mockPaymentsAllowed may also show legacy providers for testing.
    if (!mockPaymentsAllowed) {
      return LIVE_PROVIDERS.filter(option => {
        if (option === 'paypal') {
          return paymentMethods?.paypal?.configured === true;
        }
        return false;
      });
    }
    return ['paypal', ...DEV_EXTRA_PROVIDERS];
  }, [mockPaymentsAllowed, paymentMethods]);

  const [provider, setProvider] = useState(paymentMethods?.defaultProvider || 'paypal');
  const [phone, setPhone] = useState(user?.phone || '');
  const [loading, setLoading] = useState(false);
  const [paymentState, setPaymentState] = useState('pending');
  const [mockPaymentId, setMockPaymentId] = useState('');
  const [checkoutRequestId, setCheckoutRequestId] = useState('');
  const [paypalOrderId, setPaypalOrderId] = useState('');
  const [binanceTradeNo, setBinanceTradeNo] = useState('');
  const [isMockMode, setIsMockMode] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef(null);

  useEffect(() => {
    if (!availableProviders.includes(provider)) {
      setProvider(availableProviders[0] || 'paypal');
    }
  }, [availableProviders, provider]);

  const pricing = tierData?.pricing?.[billingCycle] || tierData?.pricing?.monthly || {
    price: tierData?.price || 0,
    priceCents: tierData?.priceCents || 0,
    periodLabel: billingCycle === 'yearly' ? 'year' : 'month'
  };
  const periodLabel = pricing.periodLabel || (billingCycle === 'yearly' ? 'year' : 'month');
  const binanceAmount = pricing.priceCents ? (pricing.priceCents / 100).toFixed(2) : '0.00';
  const binanceMerchantId = paymentMethods?.binance?.merchantId;

  useEffect(() => {
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
    };
  }, []);

  const startPolling = (providerName, referenceId) => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
    }

    pollRef.current = setInterval(async () => {
      try {
        let response;
        if (providerName === 'mpesa') {
          response = await subscriptionApi.getMpesaStatus(referenceId);
        } else if (providerName === 'binance') {
          response = await subscriptionApi.getBinanceStatus(referenceId);
        } else {
          return;
        }

        if (response.data.status === 'completed' || response.data.subscriptionActive) {
          clearInterval(pollRef.current);
          await onSubscriptionUpdated?.();
          setPaymentState('confirmed');
        } else if (response.data.status === 'failed') {
          clearInterval(pollRef.current);
          setError(response.data.failureReason || 'Payment failed.');
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
        billingCycle,
        phone: PHONE_PROVIDERS.has(provider) ? phone : undefined
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
          startPolling(provider, requestId);
        }
      } else if (provider === 'paypal') {
        const orderId = response.data.checkoutId;
        setPaypalOrderId(orderId);

        if (response.data.mockMode) {
          setPaymentState('initiated');
        } else if (response.data.checkoutUrl) {
          redirectToCheckout(response.data.checkoutUrl);
        } else {
          throw new Error('PayPal checkout URL not available');
        }
      } else if (provider === 'binance') {
        const tradeNo = response.data.merchantTradeNo || response.data.checkoutId;
        setBinanceTradeNo(tradeNo);

        if (response.data.mockMode) {
          setPaymentState('initiated');
        } else if (response.data.checkoutUrl) {
          redirectToCheckout(response.data.checkoutUrl);
        } else {
          throw new Error('Binance Pay checkout URL not available');
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
        tier,
        billingCycle
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
        tier,
        billingCycle
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
        tier,
        billingCycle
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

  const handleConfirmBinanceMock = async () => {
    try {
      setLoading(true);
      const response = await subscriptionApi.confirmBinanceMock({
        merchantTradeNo: binanceTradeNo,
        tier,
        billingCycle
      });

      updateUser(response.data.user);
      await onSubscriptionUpdated?.();
      setPaymentState('confirmed');
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Failed to confirm Binance Pay payment.');
      setPaymentState('error');
    } finally {
      setLoading(false);
    }
  };

  const providerLabels = {
    mpesa: 'M-Pesa (Till 5337170)',
    binance: `Binance Pay (USDT ${binanceAmount}/${periodLabel})`,
    paypal: 'PayPal / Card',
    mock: 'Mock Payment (Local Test Only)'
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
            <strong>Price:</strong> KES {pricing.price.toLocaleString()}/{periodLabel}
          </p>
          {provider === 'paypal' && (
            <p>
              <strong>PayPal/Card:</strong> USD {(pricing.priceCents / 100).toFixed(2)}/{periodLabel}
            </p>
          )}
          {provider === 'binance' && (
            <p>
              <strong>Binance Pay:</strong> USDT {binanceAmount}/{periodLabel}
              {binanceMerchantId && (
                <>
                  {' '}
                  · Merchant ID <strong>{binanceMerchantId}</strong>
                </>
              )}
            </p>
          )}
        </div>

        {paymentState === 'pending' && (
          <form onSubmit={handleInitiatePayment}>
            <div className="form-group">
              <label>Payment Method</label>
              <div className="payment-options">
                {availableProviders.map(option => (
                  <label className="radio-option" key={option}>
                    <input
                      type="radio"
                      name="provider"
                      value={option}
                      checked={provider === option}
                      onChange={e => setProvider(e.target.value)}
                    />
                    {providerLabels[option]}
                  </label>
                ))}
              </div>
            </div>

            {PHONE_PROVIDERS.has(provider) && (
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

        {paymentState === 'initiated' && provider === 'mock' && mockPaymentsAllowed && (
          <div className="mock-payment-flow">
            <div className="info-box">
              <h3>Mock Payment Initiated</h3>
              <p>
                Payment ID: <code>{mockPaymentId}</code>
              </p>
              <p>For local testing only. Click Confirm Payment to activate your subscription.</p>
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
              {isMockMode && mockPaymentsAllowed && (
                <p>
                  <em>Mock mode — M-Pesa credentials not configured. Click below to simulate payment.</em>
                </p>
              )}
            </div>
            {isMockMode && mockPaymentsAllowed && (
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
              {isMockMode && mockPaymentsAllowed ? (
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
            {isMockMode && mockPaymentsAllowed && (
              <button type="button" className="btn-confirm" onClick={handleConfirmPaypalMock} disabled={loading}>
                {loading ? 'Confirming…' : 'Simulate PayPal Payment'}
              </button>
            )}
          </div>
        )}

        {paymentState === 'initiated' && provider === 'binance' && (
          <div className="binance-flow">
            <div className="info-box">
              <h3>Binance Pay</h3>
              {isMockMode && mockPaymentsAllowed ? (
                <>
                  <p>
                    <em>Mock mode — Binance Pay credentials not configured.</em>
                  </p>
                  <p>Click below to simulate a successful crypto payment.</p>
                </>
              ) : (
                <p>Complete payment in Binance Pay. Your subscription activates automatically after confirmation.</p>
              )}
            </div>
            {isMockMode && mockPaymentsAllowed && (
              <button type="button" className="btn-confirm" onClick={handleConfirmBinanceMock} disabled={loading}>
                {loading ? 'Confirming…' : 'Simulate Binance Pay Payment'}
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
