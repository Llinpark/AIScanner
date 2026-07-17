import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../services/api';

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export default function AdminAuditLog() {
  const [entries, setEntries] = useState([]);
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await adminApi.getAuditLog({
        page,
        limit: 25,
        action: action.trim() || undefined
      });
      setEntries(response.data.entries || []);
      setPages(response.data.pages || 0);
      setTotal(response.data.total || 0);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load audit log.');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [page, action]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  return (
    <div className="admin-audit">
      <div className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h3>Audit log</h3>
            <p className="admin-table-meta">{total} admin action(s)</p>
          </div>
        </div>

        <div className="admin-toolbar">
          <input
            type="search"
            className="admin-search"
            placeholder="Filter action…"
            value={action}
            onChange={e => {
              setAction(e.target.value);
              setPage(1);
            }}
          />
          <button type="button" className="btn-fetch admin-btn" onClick={loadEntries} disabled={loading}>
            Refresh
          </button>
        </div>

        {error && <div className="feature-lock admin-alert admin-alert-error">{error}</div>}
        {loading && <div className="loading-state">Loading audit log…</div>}

        {!loading && !error && (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Admin</th>
                    <th>Action</th>
                    <th>Summary</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="admin-table-empty">
                        No audit entries yet.
                      </td>
                    </tr>
                  ) : (
                    entries.map(entry => (
                      <tr key={entry.id}>
                        <td data-label="When">{formatDate(entry.createdAt)}</td>
                        <td data-label="Admin">{entry.actorEmail}</td>
                        <td data-label="Action">
                          <span className="admin-pill role-user">{entry.action}</span>
                        </td>
                        <td data-label="Summary">{entry.summary || '—'}</td>
                        <td data-label="Target">
                          {entry.targetType ? `${entry.targetType}${entry.targetId ? `: ${entry.targetId}` : ''}` : '—'}
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
