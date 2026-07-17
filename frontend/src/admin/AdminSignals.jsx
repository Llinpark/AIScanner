import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../services/api';

const OUTCOMES = ['pending', 'tp1', 'tp2', 'tp3', 'sl', 'breakeven'];

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

export default function AdminSignals() {
  const [signals, setSignals] = useState([]);
  const [filters, setFilters] = useState({
    symbol: '',
    pattern: '',
    outcome: '',
    entriesOnly: true
  });
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [actionLoading, setActionLoading] = useState('');
  const [duplicatePreview, setDuplicatePreview] = useState(null);
  const [staleDays, setStaleDays] = useState(30);

  const loadSignals = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await adminApi.getSignals({
        page,
        limit: 25,
        symbol: filters.symbol.trim() || undefined,
        pattern: filters.pattern.trim() || undefined,
        outcome: filters.outcome || undefined,
        entriesOnly: filters.entriesOnly
      });
      setSignals(response.data.signals || []);
      setPages(response.data.pages || 0);
      setTotal(response.data.total || 0);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load signals.');
      setSignals([]);
    } finally {
      setLoading(false);
    }
  }, [page, filters.symbol, filters.pattern, filters.outcome, filters.entriesOnly]);

  useEffect(() => {
    loadSignals();
  }, [loadSignals]);

  const previewDuplicates = async () => {
    setActionLoading('duplicates');
    setMessage('');
    setError('');
    try {
      const response = await adminApi.getSignalDuplicates();
      setDuplicatePreview(response.data);
      setMessage(`Found ${response.data.duplicateCount || 0} duplicate entries in ${response.data.groups || 0} groups.`);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to analyze duplicates.');
    } finally {
      setActionLoading('');
    }
  };

  const runDedupe = async (dryRun) => {
    setActionLoading(dryRun ? 'dedupe-preview' : 'dedupe-run');
    setMessage('');
    setError('');
    try {
      const response = await adminApi.dedupeSignals({ dryRun });
      setMessage(response.data.message);
      if (!dryRun) {
        setDuplicatePreview(null);
        loadSignals();
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to dedupe signals.');
    } finally {
      setActionLoading('');
    }
  };

  const closeStale = async (dryRun) => {
    setActionLoading(dryRun ? 'stale-preview' : 'stale-run');
    setMessage('');
    setError('');
    try {
      const response = await adminApi.closeStaleSignals({ dryRun, olderThanDays: staleDays });
      setMessage(response.data.message);
      if (!dryRun) {
        loadSignals();
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to close stale signals.');
    } finally {
      setActionLoading('');
    }
  };

  const updateOutcome = async (signalId, outcome) => {
    setActionLoading(`outcome-${signalId}`);
    setMessage('');
    setError('');
    try {
      const response = await adminApi.updateSignalOutcome(signalId, { outcome });
      setMessage(response.data.message);
      setSignals(prev =>
        prev.map(signal => (signal.id === signalId ? response.data.signal : signal))
      );
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to update signal outcome.');
    } finally {
      setActionLoading('');
    }
  };

  return (
    <div className="admin-signals">
      <div className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h3>Signal hygiene</h3>
            <p className="admin-table-meta">Browse, reconcile, and clean up the global signal pool.</p>
          </div>
        </div>

        <div className="admin-action-grid">
          <div className="admin-action-card">
            <h4>Deduplicate entries</h4>
            <p>Remove duplicate entry rows that share the same symbol, direction, and price levels.</p>
            <div className="admin-inline-actions">
              <button type="button" className="btn-small admin-btn" onClick={previewDuplicates} disabled={Boolean(actionLoading)}>
                Preview
              </button>
              <button type="button" className="btn-small admin-btn" onClick={() => runDedupe(true)} disabled={Boolean(actionLoading)}>
                Dry run
              </button>
              <button type="button" className="hero-btn hero-btn-primary admin-btn-compact" onClick={() => runDedupe(false)} disabled={Boolean(actionLoading)}>
                Remove duplicates
              </button>
            </div>
            {duplicatePreview && (
              <p className="admin-action-result">
                {duplicatePreview.duplicateCount} duplicates across {duplicatePreview.groups} groups (scanned {duplicatePreview.scanned}).
              </p>
            )}
          </div>

          <div className="admin-action-card">
            <h4>Close stale opens</h4>
            <p>Mark old pending entries as closed when no SL/TP webhook arrived.</p>
            <label className="admin-field admin-field-inline">
              <span>Older than (days)</span>
              <input
                type="number"
                min={1}
                max={365}
                value={staleDays}
                onChange={e => setStaleDays(Number(e.target.value))}
              />
            </label>
            <div className="admin-inline-actions">
              <button type="button" className="btn-small admin-btn" onClick={() => closeStale(true)} disabled={Boolean(actionLoading)}>
                Preview
              </button>
              <button type="button" className="hero-btn hero-btn-primary admin-btn-compact" onClick={() => closeStale(false)} disabled={Boolean(actionLoading)}>
                Close stale entries
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="admin-panel">
        <div className="admin-panel-header">
          <div>
            <h3>Signals browser</h3>
            <p className="admin-table-meta">{total} signal(s)</p>
          </div>
        </div>

        <div className="admin-toolbar admin-filter-toolbar">
          <input
            type="search"
            className="admin-search"
            placeholder="Filter symbol…"
            value={filters.symbol}
            onChange={e => {
              setFilters(prev => ({ ...prev, symbol: e.target.value }));
              setPage(1);
            }}
          />
          <input
            type="search"
            className="admin-search"
            placeholder="Filter pattern…"
            value={filters.pattern}
            onChange={e => {
              setFilters(prev => ({ ...prev, pattern: e.target.value }));
              setPage(1);
            }}
          />
          <select
            className="admin-select"
            value={filters.outcome}
            onChange={e => {
              setFilters(prev => ({ ...prev, outcome: e.target.value }));
              setPage(1);
            }}
          >
            <option value="">All outcomes</option>
            <option value="open">Open / pending</option>
            {OUTCOMES.filter(outcome => outcome !== 'pending').map(outcome => (
              <option key={outcome} value={outcome}>
                {outcome}
              </option>
            ))}
          </select>
          <label className="admin-checkbox admin-filter-checkbox">
            <input
              type="checkbox"
              checked={filters.entriesOnly}
              onChange={e => {
                setFilters(prev => ({ ...prev, entriesOnly: e.target.checked }));
                setPage(1);
              }}
            />
            <span>Entries only</span>
          </label>
          <button type="button" className="btn-fetch admin-btn" onClick={loadSignals} disabled={loading}>
            Refresh
          </button>
        </div>

        {message && <div className="info-box admin-alert admin-alert-success">{message}</div>}
        {error && <div className="feature-lock admin-alert admin-alert-error">{error}</div>}
        {loading && <div className="loading-state">Loading signals…</div>}

        {!loading && (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Direction</th>
                    <th>Pattern</th>
                    <th>Outcome</th>
                    <th>Score</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="admin-table-empty">
                        No signals found.
                      </td>
                    </tr>
                  ) : (
                    signals.map(signal => (
                      <tr key={signal.id}>
                        <td data-label="Symbol">{signal.symbol}</td>
                        <td data-label="Direction">{signal.direction}</td>
                        <td data-label="Pattern">{signal.pattern || '—'}</td>
                        <td data-label="Outcome">
                          <span className={`admin-pill ${signal.outcome === 'pending' || !signal.outcome ? 'status-pending' : 'status-active'}`}>
                            {signal.outcome || 'pending'}
                          </span>
                        </td>
                        <td data-label="Score">{signal.pipelineScore ?? signal.confidence ?? '—'}</td>
                        <td data-label="Created">{formatDate(signal.createdAt)}</td>
                        <td data-label="Actions">
                          <select
                            className="admin-select admin-select-compact"
                            value={signal.outcome || 'pending'}
                            disabled={actionLoading === `outcome-${signal.id}`}
                            onChange={e => updateOutcome(signal.id, e.target.value)}
                          >
                            {OUTCOMES.map(outcome => (
                              <option key={outcome} value={outcome}>
                                {outcome}
                              </option>
                            ))}
                          </select>
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
