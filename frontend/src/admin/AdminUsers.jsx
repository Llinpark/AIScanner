import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../services/api';

const TIERS = ['basic', 'professional', 'premium'];
const STATUSES = ['inactive', 'pending', 'active', 'cancelled'];
const BILLING_CYCLES = ['monthly', 'weekly'];

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function formatBillingCycle(cycle) {
  return cycle === 'weekly' ? 'weekly' : cycle === 'monthly' ? 'monthly' : null;
}

// Billing cycle is only meaningful while a plan is actually in effect;
// free/never-subscribed/cancelled users shouldn't show a stale "monthly" default.
function hasBillableSubscription(subscription = {}) {
  return subscription.status === 'active' || subscription.status === 'pending';
}

function getBillingCycleLabel(subscription = {}) {
  return hasBillableSubscription(subscription) ? formatBillingCycle(subscription.billingCycle) : null;
}

function SubscriptionEditor({ user, onClose, onSaved }) {
  const subscription = user.subscription || {};
  const [tier, setTier] = useState(subscription.tier || 'basic');
  const [status, setStatus] = useState(subscription.status || 'inactive');
  const [billingCycle, setBillingCycle] = useState(formatBillingCycle(subscription.billingCycle) || 'monthly');
  const [extendDays, setExtendDays] = useState(30);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const save = async payload => {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const response = await adminApi.updateUserSubscription(user.id, payload);
      setMessage(response.data.message || 'Subscription updated.');
      onSaved(response.data.user);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update subscription.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-drawer">
      <div className="admin-drawer-header">
        <div>
          <h3>Manage subscription</h3>
          <p className="admin-table-meta">{user.email}</p>
        </div>
        <button type="button" className="btn-small admin-btn" onClick={onClose}>
          Close
        </button>
      </div>

      <dl className="admin-meta-grid admin-drawer-meta">
        <div className="admin-meta-item">
          <dt>Current tier</dt>
          <dd>{subscription.tier || 'basic'}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Current status</dt>
          <dd>{subscription.status || 'inactive'}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Billing cycle</dt>
          <dd>{getBillingCycleLabel(subscription) || '—'}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Period end</dt>
          <dd>{formatDate(subscription.current_period_end)}</dd>
        </div>
        <div className="admin-meta-item">
          <dt>Provider</dt>
          <dd>{subscription.provider || '—'}</dd>
        </div>
      </dl>

      <div className="admin-form-grid">
        <label className="admin-field">
          <span>Tier</span>
          <select className="admin-select" value={tier} onChange={e => setTier(e.target.value)}>
            {TIERS.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="admin-field">
          <span>Status</span>
          <select className="admin-select" value={status} onChange={e => setStatus(e.target.value)}>
            {STATUSES.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="admin-field">
          <span>Billing cycle</span>
          <select className="admin-select" value={billingCycle} onChange={e => setBillingCycle(e.target.value)}>
            {BILLING_CYCLES.map(option => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        <label className="admin-field">
          <span>Extend by (days)</span>
          <input type="number" min={1} max={365} value={extendDays} onChange={e => setExtendDays(Number(e.target.value))} />
        </label>
      </div>

      <div className="admin-inline-actions">
        <button
          type="button"
          className="btn-small admin-btn"
          disabled={saving}
          onClick={() => save({ tier, status, billingCycle })}
        >
          Save tier/status
        </button>
        <button
          type="button"
          className="btn-small admin-btn"
          disabled={saving}
          onClick={() => save({ tier, extendDays, billingCycle })}
        >
          Extend period
        </button>
        <button
          type="button"
          className="hero-btn hero-btn-primary admin-btn-compact"
          disabled={saving}
          onClick={() => save({ activate: true, tier, extendDays, billingCycle, provider: 'mock' })}
        >
          Activate plan
        </button>
        <button type="button" className="btn-small admin-btn admin-btn-danger" disabled={saving} onClick={() => save({ cancel: true })}>
          Cancel subscription
        </button>
      </div>

      {message && <div className="info-box admin-alert admin-alert-success">{message}</div>}
      {error && <div className="feature-lock admin-alert admin-alert-error">{error}</div>}
    </div>
  );
}

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedUser, setSelectedUser] = useState(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await adminApi.getUsers({ page, limit: 25, search: search.trim() || undefined });
      setUsers(response.data.users || []);
      setPages(response.data.pages || 0);
      setTotal(response.data.total || 0);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load users.');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleUserSaved = updatedUser => {
    setUsers(prev => prev.map(user => (user.id === updatedUser.id ? updatedUser : user)));
    setSelectedUser(updatedUser);
  };

  return (
    <div className="admin-users">
      <div className="admin-panel admin-users-panel">
        <div className="admin-panel-header">
          <div>
            <h3>Users & subscriptions</h3>
            <p className="admin-table-meta">{total} user(s)</p>
          </div>
        </div>

        <div className="admin-toolbar">
          <input
            type="search"
            className="admin-search"
            placeholder="Search email or name…"
            value={search}
            onChange={e => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <button type="button" className="btn-fetch admin-btn" onClick={loadUsers} disabled={loading}>
            Refresh
          </button>
        </div>

        {error && <div className="feature-lock admin-alert admin-alert-error">{error}</div>}
        {loading && <div className="loading-state">Loading users…</div>}

        {!loading && !error && (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Tier</th>
                    <th>Status</th>
                    <th>Period end</th>
                    <th>Role</th>
                    <th>Joined</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="admin-table-empty">
                        No users found.
                      </td>
                    </tr>
                  ) : (
                    users.map(user => (
                      <tr key={user.id}>
                        <td data-label="Email">{user.email}</td>
                        <td data-label="Name">{user.displayName || '—'}</td>
                        <td data-label="Tier">
                          {user.subscription?.tier || 'basic'}
                          {getBillingCycleLabel(user.subscription) && (
                            <span className="admin-tier-cycle"> ({getBillingCycleLabel(user.subscription)})</span>
                          )}
                        </td>
                        <td data-label="Status">
                          <span className={`admin-pill status-${user.subscription?.status || 'inactive'}`}>
                            {user.subscription?.status || 'inactive'}
                          </span>
                        </td>
                        <td data-label="Period end">{formatDate(user.subscription?.current_period_end)}</td>
                        <td data-label="Role">
                          <span className={`admin-pill ${user.role === 'admin' || user.isAdmin ? 'role-admin' : 'role-user'}`}>
                            {user.role === 'admin' || user.isAdmin ? 'admin' : 'user'}
                          </span>
                        </td>
                        <td data-label="Joined">{formatDate(user.createdAt)}</td>
                        <td data-label="Actions">
                          <button type="button" className="btn-small admin-btn" onClick={() => setSelectedUser(user)}>
                            Manage
                          </button>
                        </td>
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
          </>
        )}
      </div>

      {selectedUser && (
        <SubscriptionEditor
          user={selectedUser}
          onClose={() => setSelectedUser(null)}
          onSaved={handleUserSaved}
        />
      )}
    </div>
  );
}
