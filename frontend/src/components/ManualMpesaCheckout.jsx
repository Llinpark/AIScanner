import { useEffect, useMemo, useState } from 'react';
import { subscriptionApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

const TILL_NUMBER = '5337170';
const BUSINESS_NAME = 'KachingFx Official';
const BINANCE_ID = '484947783';

function normalizeBillingCycle(cycle) {
  return cycle === 'yearly' ? 'yearly' : 'monthly';
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Unable to read screenshot.'));
    reader.readAsDataURL(file);
  });
}

function usdtAmountFromPricing(pricing) {
  if (pricing?.priceCents != null && Number.isFinite(Number(pricing.priceCents))) {
    return Number((Number(pricing.priceCents) / 100).toFixed(2));
  }
  return null;
}

export default function ManualMpesaCheckout({
  tier,
  tierData,
  billingCycle: billingCycleProp = 'monthly',
  paymentMethods = {},
  onBack,
  onSubscriptionUpdated,
  onNavigateDashboard
}) {
  const billingCycle = normalizeBillingCycle(billingCycleProp);
  const { user, updateUser } = useAuth();
  const tillNumber = paymentMethods?.manualMpesa?.tillNumber || paymentMethods?.mpesa?.tillNumber || TILL_NUMBER;
  const businessName =
    paymentMethods?.manualMpesa?.businessName || paymentMethods?.mpesa?.businessName || BUSINESS_NAME;
  const binanceId =
    paymentMethods?.manualBinance?.binanceId || paymentMethods?.binance?.binanceId || BINANCE_ID;

  const pricing = tierData?.pricing?.[billingCycle] || tierData?.pricing?.monthly || {
    price: tierData?.price || 0,
    priceCents: tierData?.priceCents,
    periodLabel: billingCycle === 'yearly' ? 'year' : 'month'
  };
  const kesAmount = pricing.price || 0;
  const usdtAmount = usdtAmountFromPricing(pricing) ?? Number((kesAmount / 100).toFixed(2));
  const periodLabel = pricing.periodLabel || (billingCycle === 'yearly' ? 'year' : 'month');
  const planName = tierData?.name || tier;

  const [method, setMethod] = useState('manual_mpesa');
  const isBinance = method === 'manual_binance';
  const expectedAmount = isBinance ? usdtAmount : kesAmount;
  const currency = isBinance ? 'USDT' : 'KES';

  const [paymentRef, setPaymentRef] = useState('');
  const [phone, setPhone] = useState(user?.phone || '');
  const [amount, setAmount] = useState(String(expectedAmount || ''));
  const [notes, setNotes] = useState('');
  const [screenshotUrl, setScreenshotUrl] = useState('');
  const [screenshotName, setScreenshotName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(null);

  useEffect(() => {
    setAmount(String(expectedAmount || ''));
    setPaymentRef('');
    setError('');
  }, [method, expectedAmount]);

  const instructions = useMemo(() => {
    if (isBinance) {
      return [
        'Open Binance → Pay / Transfer.',
        `Send to Binance ID ${binanceId} (${businessName}).`,
        `Pay ${currency} ${Number(expectedAmount).toLocaleString()} for ${planName} (${periodLabel}).`,
        'Copy the transaction or order ID, then submit the form below.'
      ];
    }
    return [
      'Open M-Pesa → Lipa na M-Pesa → Buy Goods.',
      `Enter Till Number ${tillNumber} (${businessName}).`,
      `Pay KES ${Number(expectedAmount).toLocaleString()} for ${planName} (${periodLabel}).`,
      'Copy the confirmation code, then submit the form below.'
    ];
  }, [
    isBinance,
    binanceId,
    businessName,
    currency,
    expectedAmount,
    planName,
    periodLabel,
    tillNumber
  ]);

  const handleScreenshot = async e => {
    const file = e.target.files?.[0];
    if (!file) {
      setScreenshotUrl('');
      setScreenshotName('');
      return;
    }
    if (!file.type.startsWith('image/')) {
      setError('Screenshot must be an image file.');
      return;
    }
    if (file.size > 280_000) {
      setError('Screenshot must be under 280 KB. Compress or crop the image and try again.');
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      setScreenshotUrl(String(dataUrl));
      setScreenshotName(file.name);
      setError('');
    } catch (err) {
      setError(err.message || 'Unable to read screenshot.');
    }
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const payload = {
        tier,
        billingCycle,
        method,
        amount: Number(amount),
        notes: notes.trim(),
        screenshotUrl: screenshotUrl || undefined
      };
      if (isBinance) {
        payload.binanceTxId = paymentRef.trim();
        if (phone.trim()) payload.phoneNumber = phone.trim();
      } else {
        payload.mpesaCode = paymentRef.trim();
        payload.phoneNumber = phone.trim();
      }
      const response = await subscriptionApi.submitManualPayment(payload);
      setSubmitted(response.data.payment);
      if (response.data.user) {
        updateUser(response.data.user);
      }
      await onSubscriptionUpdated?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to submit payment. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    const refLabel = submitted.paymentMethod === 'manual_binance' ? 'Binance Tx ID' : 'M-Pesa code';
    const refValue =
      submitted.paymentReference || submitted.binanceTxId || submitted.mpesaCode || paymentRef;
    return (
      <div className="checkout-container manual-mpesa-checkout">
        <button type="button" className="mpesa-back-btn" onClick={onBack}>
          ← Back to plans
        </button>
        <div className="manual-mpesa-awaiting">
          <span className="mpesa-status-pill">Awaiting Verification</span>
          <h2>Payment received for review</h2>
          <p>
            Thanks — your {submitted.paymentMethod === 'manual_binance' ? 'Binance' : 'M-Pesa'} payment
            for <strong>{planName}</strong> was submitted. A Super Admin will verify and activate your
            subscription shortly.
          </p>
          <dl className="mpesa-receipt-grid">
            <div>
              <dt>{refLabel}</dt>
              <dd>{refValue}</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>
                {submitted.currency || currency} {Number(submitted.amount).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>Awaiting Verification</dd>
            </div>
          </dl>
          {onNavigateDashboard && (
            <button type="button" className="btn-fetch mpesa-primary-btn" onClick={onNavigateDashboard}>
              Go to dashboard
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="checkout-container manual-mpesa-checkout">
      <button type="button" className="mpesa-back-btn" onClick={onBack}>
        ← Back to plans
      </button>

      <header className="mpesa-checkout-header">
        <p className="mpesa-kicker">Secure checkout</p>
        <h2>Pay via M-Pesa or Binance</h2>
        <p className="mpesa-plan-line">
          <span className="mpesa-plan-name">{planName}</span>
          <span className="mpesa-plan-price">
            {currency} {Number(expectedAmount).toLocaleString()}
            <span>/{periodLabel}</span>
          </span>
        </p>
      </header>

      <div className="manual-pay-method-toggle" role="group" aria-label="Payment method">
        <button
          type="button"
          className={`manual-pay-method-btn ${method === 'manual_mpesa' ? 'active' : ''}`}
          onClick={() => setMethod('manual_mpesa')}
        >
          M-Pesa Till
        </button>
        <button
          type="button"
          className={`manual-pay-method-btn ${method === 'manual_binance' ? 'active' : ''}`}
          onClick={() => setMethod('manual_binance')}
        >
          Binance ID
        </button>
      </div>

      <section className="mpesa-pay-panel" aria-label="Payment destination">
        <div className="mpesa-pay-panel-top">
          <h3>Send payment to</h3>
          <p>
            {isBinance
              ? 'Transfer to the Binance ID below. Keep your transaction / order ID.'
              : 'Use Buy Goods and Till Number below. Keep your confirmation code.'}
          </p>
        </div>
        <div className="mpesa-dest-grid">
          <div className="mpesa-dest-item">
            <span className="mpesa-dest-label">Business Name</span>
            <span className="mpesa-dest-value">{businessName}</span>
          </div>
          {isBinance ? (
            <div className="mpesa-dest-item mpesa-dest-highlight">
              <span className="mpesa-dest-label">Binance ID</span>
              <span className="mpesa-dest-value mpesa-dest-till">{binanceId}</span>
            </div>
          ) : (
            <div className="mpesa-dest-item mpesa-dest-highlight">
              <span className="mpesa-dest-label">Till Number</span>
              <span className="mpesa-dest-value mpesa-dest-till">{tillNumber}</span>
            </div>
          )}
          <div className="mpesa-dest-item">
            <span className="mpesa-dest-label">Plan Price</span>
            <span className="mpesa-dest-value">
              {currency} {Number(expectedAmount).toLocaleString()}
            </span>
          </div>
          {!isBinance && (
            <div className="mpesa-dest-item">
              <span className="mpesa-dest-label">Binance ID</span>
              <span className="mpesa-dest-value">{binanceId}</span>
            </div>
          )}
          {isBinance && (
            <div className="mpesa-dest-item">
              <span className="mpesa-dest-label">M-Pesa Till</span>
              <span className="mpesa-dest-value">{tillNumber}</span>
            </div>
          )}
        </div>
        <ol className="mpesa-steps">
          {instructions.map((step, index) => (
            <li key={step}>
              <span className="mpesa-step-num" aria-hidden="true">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <form className="mpesa-form" onSubmit={handleSubmit}>
        <div className="mpesa-form-header">
          <h3>I Have Paid</h3>
          <p>
            Submit your {isBinance ? 'Binance' : 'M-Pesa'} details for verification. Access unlocks after
            approval.
          </p>
        </div>

        {error && (
          <div className="mpesa-alert mpesa-alert-error" role="alert">
            {error}
          </div>
        )}

        <div className="mpesa-fields">
          <label className="mpesa-field">
            <span>{isBinance ? 'Binance Transaction / Order ID' : 'M-Pesa Code'}</span>
            <input
              value={paymentRef}
              onChange={e => setPaymentRef(e.target.value.toUpperCase())}
              placeholder={isBinance ? 'e.g. 123456789012345678' : 'e.g. QH7X2K9M1A'}
              required
              minLength={isBinance ? 6 : 8}
              maxLength={isBinance ? 64 : 15}
              autoComplete="off"
              spellCheck={false}
            />
          </label>

          <div className="mpesa-field-row">
            <label className="mpesa-field">
              <span>Phone Number{isBinance ? ' (optional)' : ''}</span>
              <input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="2547XXXXXXXX"
                required={!isBinance}
                inputMode="tel"
                autoComplete="tel"
              />
            </label>

            <label className="mpesa-field">
              <span>Amount ({currency})</span>
              <input
                type="number"
                min={isBinance ? 0.01 : 1}
                step={isBinance ? 0.01 : 1}
                value={amount}
                onChange={e => setAmount(e.target.value)}
                required
              />
            </label>
          </div>

          <label className="mpesa-field">
            <span>Notes (optional)</span>
            <textarea
              rows={3}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Any extra detail for the admin"
              maxLength={2000}
            />
          </label>

          <label className="mpesa-upload">
            <span className="mpesa-upload-title">Upload Screenshot (optional)</span>
            <span className="mpesa-upload-hint">PNG or JPG · max 280 KB</span>
            <input type="file" accept="image/*" onChange={handleScreenshot} />
            {screenshotName ? (
              <span className="mpesa-upload-file">Attached: {screenshotName}</span>
            ) : (
              <span className="mpesa-upload-cta">Choose image</span>
            )}
          </label>
        </div>

        <button type="submit" className={`btn-subscribe btn-${tier} mpesa-submit`} disabled={loading}>
          <span className="btn-subscribe-label">{loading ? 'Submitting…' : 'I Have Paid — Submit'}</span>
        </button>
      </form>
    </div>
  );
}
