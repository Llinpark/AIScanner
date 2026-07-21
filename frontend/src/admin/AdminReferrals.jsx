import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../services/api';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function formatMoney(amount, currency) {
  if (amount == null) return '—';
  return `${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency || ''}`.trim();
}

function formatPercent(rate) {
  return `${Math.round(Number(rate || 0) * 100)}%`;
}

export default function AdminReferrals() {
  const [commissions, setCommissions] = useState([]);
  const [status, setStatus] = useState('pending');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [payingId, setPayingId] = useState('');
  const [payoutReference, setPayoutReference] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [success, setSuccess] = useState('');

  const loadCommissions = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await adminApi.getReferrals({
        page,
        limit: 25,
        status: status || undefined
      });
      setCommissions(response.data.commissions || []);
      setPages(response.data.pages || 0);
      setTotal(response.data.total || 0);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load referral commissions.');
      setCommissions([]);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    loadCommissions();
  }, [loadCommissions]);

  const handleMarkPaid = async (id) => {
    setPayingId(id);
    setError('');
    setSuccess('');
    try {
      await adminApi.markReferralPaid(id, {
        payoutReference: payoutReference.trim() || undefined,
        adminNotes: adminNotes.trim() || undefined
      });
      setSuccess('Commission marked as paid.');
      setPayoutReference('');
      setAdminNotes('');
      await loadCommissions();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to mark commission paid.');
    } finally {
      setPayingId('');
    }
  };

  return (
    <div className="admin-referrals">
      <div className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h3>Referral commissions</h3>
            <p className="admin-table-meta">{total} commission(s)</p>
          </div>
        </div>

        <div className="admin-toolbar">
          <select
            className="admin-select"
            value={status}
            onChange={e => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button type="button" className="btn-fetch admin-btn" onClick={loadCommissions} disabled={loading}>
            Refresh
          </button>
        </div>

        {error && <div className="feature-lock admin-alert admin-alert-error">{error}</div>}
        {success && <div className="page-notice info-box">{success}</div>}
        {loading && <div className="loading-state">Loading commissions…</div>}

        {!loading && !error && (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Referrer</th>
                    <th>Referred</th>
                    <th>Type</th>
                    <th>Plan</th>
                    <th>Commission</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {commissions.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="admin-table-empty">
                        No commissions found.
                      </td>
                    </tr>
                  ) : (
                    commissions.map(row => (
                      <tr key={row.id}>
                        <td data-label="Date">{formatDate(row.createdAt)}</td>
                        <td data-label="Referrer">{row.referrerEmail || row.referrerUserId}</td>
                        <td data-label="Referred">{row.referredUserEmail || row.referredUserId}</td>
                        <td data-label="Type">{row.commissionType === 'first_subscription' ? 'First' : 'Renewal'}</td>
                        <td data-label="Plan">
                          {formatMoney(row.planAmount, row.currency)}
                          <span className="admin-table-meta"> · {row.tier}</span>
                        </td>
                        <td data-label="Commission">
                          {formatMoney(row.commissionAmount, row.currency)}
                          <span className="admin-table-meta"> ({formatPercent(row.commissionRate)})</span>
                        </td>
                        <td data-label="Status">{row.status}</td>
                        <td data-label="Action">
                          {row.status === 'pending' ? (
                            <button
                              type="button"
                              className="btn-fetch admin-btn admin-btn-small"
                              disabled={payingId === row.id}
                              onClick={() => handleMarkPaid(row.id)}
                            >
                              {payingId === row.id ? 'Saving…' : 'Mark paid'}
                            </button>
                          ) : (
                            formatDate(row.paidAt)
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {pages > 1 && (
              <div className="admin-pagination">
                <button
                  type="button"
                  className="admin-btn"
                  disabled={page <= 1}
                  onClick={() => setPage(current => current - 1)}
                >
                  Previous
                </button>
                <span className="admin-table-meta">
                  Page {page} of {pages}
                </span>
                <button
                  type="button"
                  className="admin-btn"
                  disabled={page >= pages}
                  onClick={() => setPage(current => current + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h3>Payout details</h3>
            <p className="admin-table-meta">Optional reference and notes applied when marking the next commission paid.</p>
          </div>
        </div>
        <div className="admin-form-grid">
          <label className="admin-field">
            <span>Payout reference</span>
            <input
              type="text"
              className="admin-input"
              value={payoutReference}
              onChange={e => setPayoutReference(e.target.value)}
              placeholder="M-Pesa ref, PayPal batch ID, etc."
            />
          </label>
          <label className="admin-field">
            <span>Admin notes</span>
            <input
              type="text"
              className="admin-input"
              value={adminNotes}
              onChange={e => setAdminNotes(e.target.value)}
              placeholder="Internal note"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
