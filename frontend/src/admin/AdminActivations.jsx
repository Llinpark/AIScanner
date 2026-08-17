import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../services/api';

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'completed', label: 'Active / Completed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' }
];

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function formatMoney(amount, currency = 'KES') {
  if (amount == null) return '—';
  return `${currency} ${Number(amount).toLocaleString()}`;
}

function defaultExpiry(billingCycle) {
  const days = billingCycle === 'yearly' ? 365 : 30;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isBinancePayment(payment) {
  return (payment?.paymentMethod || '') === 'manual_binance';
}

function paymentMethodLabel(payment) {
  return isBinancePayment(payment) ? 'Binance ID' : 'M-Pesa Till';
}

function paymentRefLabel(payment) {
  return isBinancePayment(payment) ? 'Binance Tx ID' : 'M-Pesa Code';
}

function paymentRefValue(payment) {
  return (
    payment?.paymentReference ||
    payment?.binanceTxId ||
    payment?.mpesaCode ||
    ''
  );
}

function ApproveDialog({ payment, onClose, onApproved }) {
  const binance = isBinancePayment(payment);
  const [tier, setTier] = useState(payment.tier || 'basic');
  const [paymentRef, setPaymentRef] = useState(paymentRefValue(payment));
  const [phone, setPhone] = useState(payment.phone || '');
  const [amount, setAmount] = useState(String(payment.amount || ''));
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [expiryDate, setExpiryDate] = useState(defaultExpiry(payment.billingCycle));
  const [notes, setNotes] = useState(payment.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!window.confirm(`Activate ${payment.userEmail || 'this user'} on ${tier}?`)) return;
    setSaving(true);
    setError('');
    try {
      const payload = {
        tier,
        phoneNumber: phone,
        amount: Number(amount),
        startDate: new Date(startDate).toISOString(),
        expiryDate: new Date(`${expiryDate}T23:59:59`).toISOString(),
        notes,
        billingCycle: payment.billingCycle,
        paymentReference: paymentRef
      };
      if (binance) {
        payload.binanceTxId = paymentRef;
      } else {
        payload.mpesaCode = paymentRef;
      }
      const response = await adminApi.approveManualActivation(payment.id, payload);
      onApproved(response.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to approve payment.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-drawer">
      <div className="admin-drawer-header">
        <div>
          <h3>Approve &amp; Activate</h3>
          <p className="admin-table-meta">{payment.userEmail}</p>
        </div>
        <button type="button" className="btn-small admin-btn" onClick={onClose}>
          Close
        </button>
      </div>

      {error && <div className="feature-lock admin-alert admin-alert-error">{error}</div>}

      <div className="admin-form-grid">
        <label className="admin-field">
          <span>User</span>
          <input className="admin-input" value={payment.userName || payment.userEmail || ''} disabled />
        </label>
        <label className="admin-field">
          <span>Plan</span>
          <select className="admin-select" value={tier} onChange={e => setTier(e.target.value)}>
            <option value="basic">Basic</option>
            <option value="professional">Pro</option>
            <option value="premium">Premium</option>
          </select>
        </label>
        <label className="admin-field">
          <span>Payment Method</span>
          <input className="admin-input" value={payment.paymentMethod || 'manual_mpesa'} disabled />
        </label>
        <label className="admin-field">
          <span>{paymentRefLabel(payment)}</span>
          <input
            className="admin-input"
            value={paymentRef}
            onChange={e => setPaymentRef(e.target.value.toUpperCase())}
          />
        </label>
        <label className="admin-field">
          <span>Phone{binance ? ' (optional)' : ''}</span>
          <input className="admin-input" value={phone} onChange={e => setPhone(e.target.value)} />
        </label>
        <label className="admin-field">
          <span>Amount ({payment.currency || (binance ? 'USDT' : 'KES')})</span>
          <input className="admin-input" type="number" value={amount} onChange={e => setAmount(e.target.value)} />
        </label>
        <label className="admin-field">
          <span>Start Date</span>
          <input className="admin-input" type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
        </label>
        <label className="admin-field">
          <span>Expiry Date</span>
          <input className="admin-input" type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)} />
        </label>
        <label className="admin-field" style={{ gridColumn: '1 / -1' }}>
          <span>Notes</span>
          <textarea className="admin-input" rows={3} value={notes} onChange={e => setNotes(e.target.value)} />
        </label>
      </div>

      <div className="admin-toolbar" style={{ marginTop: '1rem' }}>
        <button type="button" className="btn-fetch admin-btn" onClick={submit} disabled={saving}>
          {saving ? 'Activating…' : 'Activate Subscription'}
        </button>
      </div>
    </div>
  );
}

function ViewDialog({ payment, onClose }) {
  return (
    <div className="admin-drawer">
      <div className="admin-drawer-header">
        <div>
          <h3>Payment details</h3>
          <p className="admin-table-meta">{payment.userEmail}</p>
        </div>
        <button type="button" className="btn-small admin-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="admin-meta-grid admin-drawer-meta">
        <div className="admin-meta-item">
          <dt>User</dt>
          <dd>{payment.userName || payment.userEmail || '—'}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Plan</dt>
          <dd>{payment.tier}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Method</dt>
          <dd>{paymentMethodLabel(payment)}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Phone</dt>
          <dd>{payment.phone || '—'}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>{paymentRefLabel(payment)}</dt>
          <dd>{paymentRefValue(payment) || '—'}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Amount</dt>
          <dd>{formatMoney(payment.amount, payment.currency)}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Submitted</dt>
          <dd>{formatDate(payment.createdAt)}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Status</dt>
          <dd>{payment.status}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Activated by</dt>
          <dd>{payment.activatedBy || '—'}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Notes</dt>
          <dd>{payment.notes || '—'}</dd>
        </div>
      </dl>
      {payment.screenshotUrl ? (
        <div className="admin-panel" style={{ marginTop: '1rem' }}>
          <h4>Screenshot</h4>
          <img
            src={payment.screenshotUrl}
            alt="Payment screenshot"
            style={{ maxWidth: '100%', borderRadius: 8 }}
          />
        </div>
      ) : null}
    </div>
  );
}

export default function AdminActivations() {
  const [payments, setPayments] = useState([]);
  const [status, setStatus] = useState('pending');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [viewPayment, setViewPayment] = useState(null);
  const [approvePayment, setApprovePayment] = useState(null);
  const [notesPayment, setNotesPayment] = useState(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await adminApi.getManualActivations({
        page,
        limit: 25,
        status: status || undefined,
        search: search || undefined
      });
      setPayments(response.data.payments || []);
      setPages(response.data.pages || 0);
      setTotal(response.data.total || 0);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load activations.');
      setPayments([]);
    } finally {
      setLoading(false);
    }
  }, [page, status, search]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const rejectPayment = async payment => {
    const notes = window.prompt('Rejection reason / notes (optional):', '') ?? null;
    if (notes === null) return;
    const ref = paymentRefValue(payment);
    if (!window.confirm(`Reject payment ${ref || payment.id}?`)) return;
    setBusyId(payment.id);
    try {
      await adminApi.rejectManualActivation(payment.id, { notes });
      setToast('Payment rejected.');
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to reject payment.');
    } finally {
      setBusyId('');
    }
  };

  const saveNotes = async () => {
    if (!notesPayment) return;
    setBusyId(notesPayment.id);
    try {
      await adminApi.updateManualActivationNotes(notesPayment.id, { notes: notesDraft });
      setToast('Notes saved.');
      setNotesPayment(null);
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to save notes.');
    } finally {
      setBusyId('');
    }
  };

  const extendUser = async payment => {
    const days = window.prompt('Extend by how many days?', '30');
    if (days == null) return;
    if (!window.confirm(`Extend ${payment.userEmail} by ${days} days?`)) return;
    setBusyId(payment.id);
    try {
      await adminApi.extendManualActivationUser(payment.userId, { days: Number(days) });
      setToast('Subscription extended.');
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to extend subscription.');
    } finally {
      setBusyId('');
    }
  };

  const cancelUser = async payment => {
    if (!window.confirm(`Cancel subscription for ${payment.userEmail}?`)) return;
    setBusyId(payment.id);
    try {
      await adminApi.cancelManualActivationUser(payment.userId, { notes: 'Cancelled from Activations' });
      setToast('Subscription cancelled.');
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to cancel subscription.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="admin-activations">
      <div className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h3>Manual Activations</h3>
            <p className="admin-table-meta">
              Super Admin — verify M-Pesa Till and Binance ID payments, then grant access. {total}{' '}
              record(s)
            </p>
          </div>
        </div>

        {toast && <div className="admin-alert admin-alert-success">{toast}</div>}
        {error && <div className="feature-lock admin-alert admin-alert-error">{error}</div>}

        <div className="admin-toolbar admin-activations-toolbar">
          <input
            className="admin-input"
            placeholder="Search name, email, phone, M-Pesa code, Binance Tx ID"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                setSearch(searchInput.trim());
                setPage(1);
              }
            }}
          />
          <select
            className="admin-select"
            value={status}
            onChange={e => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            {STATUS_FILTERS.map(opt => (
              <option key={opt.value || 'all'} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-fetch admin-btn"
            onClick={() => {
              setSearch(searchInput.trim());
              setPage(1);
              load();
            }}
            disabled={loading}
          >
            Search
          </button>
          <button type="button" className="btn-small admin-btn" onClick={load} disabled={loading}>
            Refresh
          </button>
        </div>

        {loading && <div className="loading-state">Loading activations…</div>}

        {!loading && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Plan</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Amount</th>
                  <th>Submitted</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {payments.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="admin-table-empty">
                      No payment requests found.
                    </td>
                  </tr>
                ) : (
                  payments.map(payment => (
                    <tr key={payment.id}>
                      <td data-label="User">
                        <div>{payment.userName || '—'}</div>
                        <small className="admin-table-meta">{payment.userEmail}</small>
                        {payment.phone ? (
                          <small className="admin-table-meta">{payment.phone}</small>
                        ) : null}
                      </td>
                      <td data-label="Plan">{payment.tier}</td>
                      <td data-label="Method">{paymentMethodLabel(payment)}</td>
                      <td data-label="Reference">{paymentRefValue(payment) || '—'}</td>
                      <td data-label="Amount">{formatMoney(payment.amount, payment.currency)}</td>
                      <td data-label="Submitted">{formatDate(payment.createdAt)}</td>
                      <td data-label="Status">
                        <span
                          className={`admin-pill status-${
                            payment.status === 'completed'
                              ? 'active'
                              : payment.status === 'pending'
                                ? 'pending'
                                : 'inactive'
                          }`}
                        >
                          {payment.status}
                        </span>
                      </td>
                      <td data-label="Actions">
                        <div className="admin-row-actions">
                          <button type="button" className="btn-small admin-btn" onClick={() => setViewPayment(payment)}>
                            View
                          </button>
                          {payment.status === 'pending' && (
                            <button
                              type="button"
                              className="btn-small admin-btn"
                              disabled={busyId === payment.id}
                              onClick={() => setApprovePayment(payment)}
                            >
                              Approve
                            </button>
                          )}
                          {payment.status === 'pending' && (
                            <button
                              type="button"
                              className="btn-small admin-btn"
                              disabled={busyId === payment.id}
                              onClick={() => rejectPayment(payment)}
                            >
                              Reject
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn-small admin-btn"
                            onClick={() => {
                              setNotesPayment(payment);
                              setNotesDraft(payment.notes || '');
                            }}
                          >
                            Notes
                          </button>
                          {payment.status === 'completed' && (
                            <>
                              <button
                                type="button"
                                className="btn-small admin-btn"
                                disabled={busyId === payment.id}
                                onClick={() => extendUser(payment)}
                              >
                                Extend
                              </button>
                              <button
                                type="button"
                                className="btn-small admin-btn"
                                disabled={busyId === payment.id}
                                onClick={() => cancelUser(payment)}
                              >
                                Cancel
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <div className="admin-pagination">
            <button type="button" className="btn-small admin-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              Previous
            </button>
            <span className="admin-page-label">
              Page {page} of {pages}
            </span>
            <button
              type="button"
              className="btn-small admin-btn"
              disabled={page >= pages}
              onClick={() => setPage(p => p + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>

      {viewPayment && <ViewDialog payment={viewPayment} onClose={() => setViewPayment(null)} />}
      {approvePayment && (
        <ApproveDialog
          payment={approvePayment}
          onClose={() => setApprovePayment(null)}
          onApproved={() => {
            setApprovePayment(null);
            setToast('Subscription activated.');
            load();
          }}
        />
      )}
      {notesPayment && (
        <div className="admin-drawer">
          <div className="admin-drawer-header">
            <div>
              <h3>Edit notes</h3>
              <p className="admin-table-meta">{paymentRefValue(notesPayment)}</p>
            </div>
            <button type="button" className="btn-small admin-btn" onClick={() => setNotesPayment(null)}>
              Close
            </button>
          </div>
          <textarea className="admin-input" rows={5} value={notesDraft} onChange={e => setNotesDraft(e.target.value)} />
          <div className="admin-toolbar" style={{ marginTop: '1rem' }}>
            <button type="button" className="btn-fetch admin-btn" onClick={saveNotes} disabled={busyId === notesPayment.id}>
              Save notes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
