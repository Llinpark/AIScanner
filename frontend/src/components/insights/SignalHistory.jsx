import { useCallback, useEffect, useState } from 'react';
import { analyticsApi } from '../../services/api';
import { SignalHistoryRow } from './RiskAnalysisCard';

export default function SignalHistory({ tierLimits, onAddToJournal }) {
  const [signals, setSignals] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    symbol: '',
    direction: '',
    outcome: '',
    alertType: ''
  });

  const loadHistory = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await analyticsApi.getHistory({
        page,
        limit: 15,
        ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v))
      });
      setSignals(res.data.signals || []);
      setTotalPages(res.data.totalPages || 1);
      setTotal(res.data.total || 0);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load signal history.');
      setSignals([]);
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const applyFilters = e => {
    e.preventDefault();
    setPage(1);
    loadHistory();
  };

  return (
    <div className="insights-section">
      <div className="insights-section-header">
        <h3>Signal History</h3>
        <p>{total} signals in your plan window ({tierLimits.historyDays || 7} days)</p>
      </div>

      <form className="history-filters" onSubmit={applyFilters}>
        <input
          type="text"
          placeholder="Symbol"
          value={filters.symbol}
          onChange={e => setFilters(f => ({ ...f, symbol: e.target.value }))}
        />
        <select value={filters.direction} onChange={e => setFilters(f => ({ ...f, direction: e.target.value }))}>
          <option value="">All directions</option>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
        <select value={filters.outcome} onChange={e => setFilters(f => ({ ...f, outcome: e.target.value }))}>
          <option value="">All outcomes</option>
          <option value="pending">Open</option>
          <option value="tp1">TP1</option>
          <option value="tp2">TP2</option>
          <option value="tp3">TP3</option>
          <option value="sl">SL</option>
        </select>
        <select value={filters.alertType} onChange={e => setFilters(f => ({ ...f, alertType: e.target.value }))}>
          <option value="">All alert types</option>
          <option value="entry">Entry</option>
          <option value="stop_loss">Stop Loss</option>
          <option value="take_profit_1">TP1</option>
          <option value="take_profit_2">TP2</option>
          <option value="take_profit_3">TP3</option>
        </select>
        <button type="submit" className="btn-fetch" disabled={loading}>
          {loading ? 'Loading…' : 'Filter'}
        </button>
      </form>

      {error && <div className="feature-lock">{error}</div>}

      <div className="history-table insights-history-table">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Symbol</th>
              <th>Dir</th>
              <th>Type</th>
              <th>Outcome</th>
              <th>R</th>
              <th>Conf.</th>
              <th>Levels</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {signals.length === 0 ? (
              <tr>
                <td colSpan={9} className="empty-cell">
                  {loading ? 'Loading…' : 'No signals match your filters.'}
                </td>
              </tr>
            ) : (
              signals.map(signal => (
                <SignalHistoryRow
                  key={signal._id || `${signal.symbol}-${signal.createdAt}`}
                  signal={signal}
                  tierLimits={tierLimits}
                  onAddToJournal={onAddToJournal}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination-row">
        <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {totalPages}
        </span>
        <button type="button" disabled={page >= totalPages || loading} onClick={() => setPage(p => p + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
