import { useCallback, useEffect, useState } from 'react';
import { referralApi } from '../services/api';

function formatPercent(rate) {
  return `${Math.round(Number(rate || 0) * 100)}%`;
}

function formatMoney(amount, currency) {
  if (amount == null) return '—';
  return `${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency || ''}`.trim();
}

function formatTotals(totals) {
  const entries = Object.entries(totals || {});
  if (!entries.length) return '—';
  return entries.map(([currency, amount]) => formatMoney(amount, currency)).join(' · ');
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export default function ReferAndEarn({ subscription, onNavigatePricing }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await referralApi.getMe();
      setData(response.data);
    } catch (err) {
      const apiMessage = err.response?.data?.message;
      const apiError = err.response?.data?.error;
      const status = err.response?.status;
      let message = apiMessage || 'Unable to load referral dashboard.';
      if (status === 404) {
        message = 'Referral API not found. Restart the backend server and try again.';
      } else if (apiError && apiError !== apiMessage) {
        message = `${message} (${apiError})`;
      }
      setError(message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const handleCopy = async () => {
    if (!data?.referralLink) return;
    try {
      await navigator.clipboard.writeText(data.referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const isActive = String(subscription?.status || '').toLowerCase() === 'active';

  if (loading) {
    return <div className="loading-state">Loading referral dashboard…</div>;
  }

  if (error) {
    return (
      <div className="dashboard-card refer-earn-card">
        <h2>Refer &amp; Earn</h2>
        <div className="feature-lock">{error}</div>
      </div>
    );
  }

  if (!isActive || !data?.eligible) {
    return (
      <div className="dashboard-card refer-earn-card">
        <span className="refer-earn-badge">Refer &amp; Earn</span>
        <h2>Share KachingFX and earn commissions</h2>
        <p className="refer-earn-lead">
          Earn {formatPercent(data?.rates?.first)} on your referral&apos;s first subscription payment and{' '}
          {formatPercent(data?.rates?.renewal)} on every renewal.
        </p>
        <div className="feature-lock">
          {data?.message || 'Activate a subscription to unlock your personal referral link.'}
        </div>
        <button type="button" className="btn-fetch" onClick={onNavigatePricing}>
          View pricing
        </button>
      </div>
    );
  }

  return (
    <div className="refer-earn-page">
      <header className="refer-earn-hero">
        <span className="refer-earn-badge">Refer &amp; Earn</span>
        <h2>Your referral link</h2>
        <p>
          Earn {formatPercent(data.rates.first)} on first payments and {formatPercent(data.rates.renewal)} on renewals.
          Commissions are paid manually after admin review.
        </p>
      </header>

      <div className="refer-earn-link-card dashboard-card">
        <label className="refer-earn-label" htmlFor="referral-link">
          Share this link
        </label>
        <div className="refer-earn-link-row">
          <input id="referral-link" className="refer-earn-input" readOnly value={data.referralLink} />
          <button type="button" className="btn-fetch" onClick={handleCopy}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
        <p className="refer-earn-code">
          Code: <strong>{data.referralCode}</strong>
        </p>
      </div>

      <div className="refer-earn-stats">
        <div className="refer-earn-stat dashboard-card">
          <span className="refer-earn-stat-label">Referrals</span>
          <strong>{data.referralCount || 0}</strong>
        </div>
        <div className="refer-earn-stat dashboard-card">
          <span className="refer-earn-stat-label">Pending</span>
          <strong>{formatTotals(data.totals?.pending)}</strong>
        </div>
        <div className="refer-earn-stat dashboard-card">
          <span className="refer-earn-stat-label">Paid out</span>
          <strong>{formatTotals(data.totals?.paid)}</strong>
        </div>
      </div>

      <section className="dashboard-card refer-earn-section">
        <h3>Commission history</h3>
        {!data.commissions?.length ? (
          <p className="refer-earn-empty">No commissions yet. Share your link to get started.</p>
        ) : (
          <div className="refer-earn-table-wrap">
            <table className="admin-table refer-earn-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Referral</th>
                  <th>Type</th>
                  <th>Plan</th>
                  <th>Commission</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.commissions.map(row => (
                  <tr key={row.id}>
                    <td>{formatDate(row.createdAt)}</td>
                    <td>{row.referredUserEmail}</td>
                    <td>{row.commissionType === 'first_subscription' ? 'First payment' : 'Renewal'}</td>
                    <td>
                      {formatMoney(row.planAmount, row.currency)}
                      <span className="refer-earn-meta"> · {row.tier}</span>
                    </td>
                    <td>
                      {formatMoney(row.commissionAmount, row.currency)}
                      <span className="refer-earn-meta"> ({formatPercent(row.commissionRate)})</span>
                    </td>
                    <td>
                      <span className={`refer-earn-status refer-earn-status-${row.status}`}>{row.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dashboard-card refer-earn-section">
        <h3>Your referrals</h3>
        {!data.referrals?.length ? (
          <p className="refer-earn-empty">No one has signed up with your link yet.</p>
        ) : (
          <div className="refer-earn-table-wrap">
            <table className="admin-table refer-earn-table">
              <thead>
                <tr>
                  <th>Joined</th>
                  <th>User</th>
                  <th>Status</th>
                  <th>Plan</th>
                </tr>
              </thead>
              <tbody>
                {data.referrals.map(row => (
                  <tr key={row.id}>
                    <td>{formatDate(row.joinedAt)}</td>
                    <td>{row.displayName || row.email}</td>
                    <td>{row.subscriptionStatus}</td>
                    <td>{row.tier}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
