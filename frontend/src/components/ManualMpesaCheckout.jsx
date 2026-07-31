import { useMemo, useState } from 'react';
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
  const binanceId = paymentMethods?.binance?.binanceId || BINANCE_ID;

  const pricing = tierData?.pricing?.[billingCycle] || tierData?.pricing?.monthly || {
    price: tierData?.price || 0,
    periodLabel: billingCycle === 'yearly' ? 'year' : 'month'
  };
  const expectedAmount = pricing.price || 0;
  const periodLabel = pricing.periodLabel || (billingCycle === 'yearly' ? 'year' : 'month');

  const [mpesaCode, setMpesaCode] = useState('');
  const [phone, setPhone] = useState(user?.phone || '');
  const [amount, setAmount] = useState(String(expectedAmount || ''));
  const [notes, setNotes] = useState('');
  const [screenshotUrl, setScreenshotUrl] = useState('');
  const [screenshotName, setScreenshotName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(null);

  const instructions = useMemo(
    () => [
      `Open M-Pesa on your phone and choose Lipa na M-Pesa → Buy Goods.`,
      `Enter Till Number ${tillNumber} (${businessName}).`,
      `Pay KES ${Number(expectedAmount).toLocaleString()} for the ${tierData?.name || tier} plan (${periodLabel}).`,
      'Save the M-Pesa confirmation code, then fill the form below.'
    ],
    [tillNumber, businessName, expectedAmount, tierData?.name, tier, periodLabel]
  );

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
      const response = await subscriptionApi.submitManualPayment({
        tier,
        billingCycle,
        mpesaCode: mpesaCode.trim(),
        phoneNumber: phone.trim(),
        amount: Number(amount),
        notes: notes.trim(),
        screenshotUrl: screenshotUrl || undefined
      });
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
    return (
      <div className="checkout-container manual-mpesa-checkout">
        <button type="button" className="btn-small checkout-back" onClick={onBack}>
          ← Back to plans
        </button>
        <div className="manual-mpesa-awaiting">
          <span className="admin-pill status-pending">Awaiting Verification</span>
          <h2>Payment received for review</h2>
          <p>
            Thanks — your M-Pesa payment for <strong>{tierData?.name || tier}</strong> was submitted.
            A Super Admin will verify the code and activate your subscription shortly.
          </p>
          <dl className="admin-meta-grid">
            <div className="admin-meta-item">
              <dt>M-Pesa code</dt>
              <dd>{submitted.mpesaCode}</dd>
            </div>
            <div className="admin-meta-item">
              <dt>Amount</dt>
              <dd>
                {submitted.currency || 'KES'} {Number(submitted.amount).toLocaleString()}
              </dd>
            </div>
            <div className="admin-meta-item">
              <dt>Status</dt>
              <dd>Awaiting Verification</dd>
            </div>
          </dl>
          {onNavigateDashboard && (
            <button type="button" className="btn-fetch" onClick={onNavigateDashboard}>
              Go to dashboard
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="checkout-container manual-mpesa-checkout">
      <button type="button" className="btn-small checkout-back" onClick={onBack}>
        ← Back to plans
      </button>

      <div className="checkout-header">
        <h2>Pay via M-Pesa Till</h2>
        <p>
          <strong>{tierData?.name || tier}</strong> · KES {Number(expectedAmount).toLocaleString()}/
          {periodLabel}
        </p>
      </div>

      <section className="manual-mpesa-till-card" aria-label="M-Pesa Till details">
        <p className="pricing-payment-intro">Send payment to:</p>
        <ul className="pricing-payment-details">
          <li>
            <span className="pricing-payment-label">Business Name</span>
            <span className="pricing-payment-value">{businessName}</span>
          </li>
          <li>
            <span className="pricing-payment-label">Till Number</span>
            <span className="pricing-payment-value">{tillNumber}</span>
          </li>
          <li>
            <span className="pricing-payment-label">Plan Price</span>
            <span className="pricing-payment-value">KES {Number(expectedAmount).toLocaleString()}</span>
          </li>
          <li>
            <span className="pricing-payment-label">Binance Pay — Binance ID</span>
            <span className="pricing-payment-value">{binanceId}</span>
          </li>
        </ul>
        <ol className="manual-mpesa-steps">
          {instructions.map(step => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>

      <form className="checkout-form manual-mpesa-form" onSubmit={handleSubmit}>
        <h3>I Have Paid</h3>
        <p className="admin-table-meta">Submit your M-Pesa details for verification. Access unlocks after approval.</p>

        {error && <div className="feature-lock admin-alert admin-alert-error">{error}</div>}

        <label className="admin-field">
          <span>M-Pesa Code</span>
          <input
            className="admin-input"
            value={mpesaCode}
            onChange={e => setMpesaCode(e.target.value.toUpperCase())}
            placeholder="e.g. QH7X2K9M1A"
            required
            minLength={8}
            maxLength={15}
            autoComplete="off"
          />
        </label>

        <label className="admin-field">
          <span>Phone Number</span>
          <input
            className="admin-input"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="2547XXXXXXXX"
            required
            inputMode="tel"
          />
        </label>

        <label className="admin-field">
          <span>Amount (KES)</span>
          <input
            className="admin-input"
            type="number"
            min={1}
            step={1}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            required
          />
        </label>

        <label className="admin-field">
          <span>Notes (optional)</span>
          <textarea
            className="admin-input"
            rows={3}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Any extra detail for the admin"
            maxLength={2000}
          />
        </label>

        <label className="admin-field">
          <span>Upload Screenshot (optional)</span>
          <input type="file" accept="image/*" onChange={handleScreenshot} />
          {screenshotName ? <small className="admin-table-meta">Attached: {screenshotName}</small> : null}
        </label>

        <button type="submit" className={`btn-subscribe btn-${tier}`} disabled={loading}>
          <span className="btn-subscribe-label">{loading ? 'Submitting…' : 'I Have Paid — Submit'}</span>
        </button>
      </form>
    </div>
  );
}
