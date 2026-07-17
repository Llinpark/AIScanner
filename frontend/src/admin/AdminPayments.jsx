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

export default function AdminPayments() {
  const [payments, setPayments] = useState([]);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadPayments = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await adminApi.getPayments({
        page,
        limit: 25,
        status: status || undefined
      });
      setPayments(response.data.payments || []);
      setPages(response.data.pages || 0);
      setTotal(response.data.total || 0);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load payments.');
      setPayments([]);
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    loadPayments();
  }, [loadPayments]);

  return (
    <div className="admin-payments">
      <div className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h3>Payments</h3>
            <p className="admin-table-meta">{total} transaction(s)</p>
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
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button type="button" className="btn-fetch admin-btn" onClick={loadPayments} disabled={loading}>
            Refresh
          </button>
        </div>

        {error && <div className="feature-lock admin-alert admin-alert-error">{error}</div>}
        {loading && <div className="loading-state">Loading payments…</div>}

        {!loading && !error && (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Tier</th>
                    <th>Provider</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Reference</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="admin-table-empty">
                        No payments found.
                      </td>
                    </tr>
                  ) : (
                    payments.map(payment => (
                      <tr key={payment.id}>
                        <td data-label="User">{payment.userEmail || payment.userId || '—'}</td>
                        <td data-label="Tier">{payment.tier}</td>
                        <td data-label="Provider">{payment.provider}</td>
                        <td data-label="Amount">{formatMoney(payment.amount, payment.currency)}</td>
                        <td data-label="Status">
                          <span className={`admin-pill status-${payment.status === 'completed' ? 'active' : payment.status === 'pending' ? 'pending' : 'inactive'}`}>
                            {payment.status}
                          </span>
                        </td>
                        <td data-label="Reference">{payment.providerReference || '—'}</td>
                        <td data-label="Created">{formatDate(payment.createdAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {pages > 1 && (
              <div className="admin-pagination">
                <button type="button" className="btn-small admin-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  Previous
                </button>
                <span className="admin-page-label">
                  Page {page} of {pages}
                </span>
                <button type="button" className="btn-small admin-btn" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
