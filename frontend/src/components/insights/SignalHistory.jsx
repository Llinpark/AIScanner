import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { analyticsApi } from '../../services/api';
import OutcomeBadge from './RiskAnalysisCard';
import {
  formatConfidence,
  formatDeliveryStatus,
  formatExecutionStatus,
  formatSignalSource,
  formatStrategyName,
  isInsightsSignal
} from '../../utils/insightsSignal';

const HISTORY_COLUMNS = [
  { key: 'time', label: 'Time' },
  { key: 'symbol', label: 'Symbol' },
  { key: 'timeframe', label: 'Timeframe' },
  { key: 'direction', label: 'Direction' },
  { key: 'strategy', label: 'Strategy' },
  { key: 'source', label: 'Source' },
  { key: 'outcome', label: 'Outcome' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'execution', label: 'Execution Status' },
  { key: 'delivery', label: 'Delivery Status' },
  { key: 'journal', label: 'Journal' }
];

const SignalHistoryCard = memo(function SignalHistoryCard({ signal, tierLimits, onAddToJournal }) {
  const strategy = formatStrategyName(signal);
  const source = formatSignalSource(signal);
  const delivery = formatDeliveryStatus(signal);
  const execution = formatExecutionStatus(signal);
  const time = signal.createdAt ? new Date(signal.createdAt).toLocaleString() : '—';

  return (
    <article className="insights-signal-card">
      <div className="insights-signal-card-top">
        <div>
          <strong className="insights-signal-symbol">{signal.symbol}</strong>
          <span className={`insights-dir insights-dir-${signal.direction || 'long'}`}>
            {(signal.direction || '—').toUpperCase()}
          </span>
        </div>
        <OutcomeBadge outcome={signal.outcome} tradeStatus={signal.tradeStatus} />
      </div>

      <dl className="insights-signal-meta">
        <div>
          <dt>Time</dt>
          <dd>{time}</dd>
        </div>
        <div>
          <dt>Timeframe</dt>
          <dd>{signal.timeframe || '1h'}</dd>
        </div>
        <div>
          <dt>Strategy</dt>
          <dd>{strategy}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{source}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{formatConfidence(signal, tierLimits.showConfidence)}</dd>
        </div>
        <div>
          <dt>Execution</dt>
          <dd className="insights-status-text">{execution}</dd>
        </div>
        <div>
          <dt>Delivery</dt>
          <dd className="insights-status-text">{delivery}</dd>
        </div>
      </dl>

      {tierLimits.tradeJournal && onAddToJournal && (
        <button type="button" className="btn-small insights-journal-btn" onClick={() => onAddToJournal(signal)}>
          + Journal
        </button>
      )}
    </article>
  );
});

const SignalHistoryRow = memo(function SignalHistoryRow({ signal, tierLimits, onAddToJournal }) {
  const strategy = formatStrategyName(signal);
  const source = formatSignalSource(signal);
  const delivery = formatDeliveryStatus(signal);
  const execution = formatExecutionStatus(signal);
  const time = signal.createdAt ? new Date(signal.createdAt).toLocaleString() : '—';

  return (
    <tr>
      <td data-label="Time">{time}</td>
      <td data-label="Symbol">{signal.symbol}</td>
      <td data-label="Timeframe">{signal.timeframe || '1h'}</td>
      <td data-label="Direction">{(signal.direction || '—').toUpperCase()}</td>
      <td data-label="Strategy">{strategy}</td>
      <td data-label="Source">{source}</td>
      <td data-label="Outcome">
        <OutcomeBadge outcome={signal.outcome} tradeStatus={signal.tradeStatus} />
      </td>
      <td data-label="Confidence">{formatConfidence(signal, tierLimits.showConfidence)}</td>
      <td data-label="Execution Status">{execution}</td>
      <td data-label="Delivery Status">{delivery}</td>
      <td data-label="Journal">
        {tierLimits.tradeJournal && onAddToJournal ? (
          <button type="button" className="btn-small" onClick={() => onAddToJournal(signal)}>
            + Journal
          </button>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
});

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
      const list = (res.data.signals || []).filter(isInsightsSignal);
      setSignals(list);
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

  const historyDays = tierLimits.historyDays || 7;
  const hasActiveFilters = Boolean(
    filters.symbol || filters.direction || filters.outcome || filters.alertType
  );
  const emptyMessage = useMemo(() => {
    if (loading) return 'Loading…';
    if (total === 0 && !hasActiveFilters) {
      return `No TradingView webhook signals in the last ${historyDays} days yet. Insights fills from live TradingView alerts (not auto-scan). After your Pine strategy fires an alert to the webhook, history, analytics, and journal prefill will populate here.`;
    }
    if (signals.length === 0 && hasActiveFilters) {
      return 'No TradingView signals match your filters.';
    }
    return 'No TradingView signals to show.';
  }, [loading, total, hasActiveFilters, historyDays, signals.length]);

  return (
    <div className="insights-section">
      <div className="insights-section-header">
        <h3>Signal History</h3>
        <p>
          {total} webhook signals in your plan window ({historyDays} days)
        </p>
      </div>

      <form className="history-filters" onSubmit={applyFilters}>
        <input
          type="text"
          placeholder="Symbol"
          value={filters.symbol}
          onChange={e => setFilters(f => ({ ...f, symbol: e.target.value }))}
          aria-label="Filter by symbol"
        />
        <select
          value={filters.direction}
          onChange={e => setFilters(f => ({ ...f, direction: e.target.value }))}
          aria-label="Filter by direction"
        >
          <option value="">All directions</option>
          <option value="long">Long</option>
          <option value="short">Short</option>
        </select>
        <select
          value={filters.outcome}
          onChange={e => setFilters(f => ({ ...f, outcome: e.target.value }))}
          aria-label="Filter by outcome"
        >
          <option value="">All outcomes</option>
          <option value="pending">Open</option>
          <option value="tp1">TP1</option>
          <option value="tp2">TP2</option>
          <option value="tp3">TP3</option>
          <option value="sl">SL</option>
        </select>
        <select
          value={filters.alertType}
          onChange={e => setFilters(f => ({ ...f, alertType: e.target.value }))}
          aria-label="Filter by alert type"
        >
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

      <div className="insights-history-cards" aria-live="polite">
        {signals.length === 0 ? (
          <div className="insights-empty">{emptyMessage}</div>
        ) : (
          signals.map(signal => (
            <SignalHistoryCard
              key={signal._id || `${signal.symbol}-${signal.createdAt}`}
              signal={signal}
              tierLimits={tierLimits}
              onAddToJournal={onAddToJournal}
            />
          ))
        )}
      </div>

      <div className="history-table insights-history-table">
        <table>
          <thead>
            <tr>
              {HISTORY_COLUMNS.map(col => (
                <th key={col.key}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {signals.length === 0 ? (
              <tr>
                <td colSpan={HISTORY_COLUMNS.length} className="empty-cell">
                  {emptyMessage}
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
