import { useEffect, useState } from 'react';
import { journalApi } from '../../services/api';

const EMPTY_FORM = {
  symbol: '',
  direction: 'long',
  entry: '',
  exit: '',
  lotSize: '',
  outcome: 'open',
  outcomeR: '',
  pnl: '',
  notes: '',
  userNotes: '',
  tradeRating: '',
  emotion: '',
  lessonsLearned: '',
  screenshotUrl: '',
  executionNotes: ''
};

export default function TradeJournal({ tierLimits, prefill, onNavigatePricing, onPrefillConsumed }) {
  const [entries, setEntries] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState(null);

  const loadEntries = () => {
    setLoading(true);
    journalApi
      .list()
      .then(res => setEntries(res.data.entries || []))
      .catch(err => setError(err.response?.data?.message || 'Failed to load journal.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!tierLimits.tradeJournal) {
      setLoading(false);
      return;
    }
    loadEntries();
  }, [tierLimits.tradeJournal]);

  useEffect(() => {
    if (!prefill) return;
    setForm({
      symbol: prefill.symbol || '',
      direction: prefill.direction || 'long',
      entry: prefill.entry ?? '',
      exit: '',
      lotSize: prefill.riskMetrics?.suggestedLotSize ?? '',
      outcome: prefill.outcome === 'sl' ? 'loss' : prefill.outcome?.startsWith('tp') ? 'win' : 'open',
      outcomeR: prefill.outcomeR ?? '',
      pnl: '',
      notes: '',
      userNotes: '',
      tradeRating: '',
      emotion: '',
      lessonsLearned: '',
      screenshotUrl: '',
      executionNotes: prefill.tradeExplanation || prefill.notes || ''
    });
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  if (!tierLimits.tradeJournal) {
    return (
      <div className="insights-section">
        <div className="feature-lock">
          Trade journal requires Pro or Premium.{' '}
          <button type="button" className="link-btn" onClick={onNavigatePricing}>
            Upgrade
          </button>
        </div>
      </div>
    );
  }

  const handleSubmit = async e => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...form,
        entry: form.entry !== '' ? Number(form.entry) : undefined,
        exit: form.exit !== '' ? Number(form.exit) : undefined,
        lotSize: form.lotSize !== '' ? Number(form.lotSize) : undefined,
        outcomeR: form.outcomeR !== '' ? Number(form.outcomeR) : undefined,
        pnl: form.pnl !== '' ? Number(form.pnl) : undefined,
        tradeRating: form.tradeRating !== '' ? Number(form.tradeRating) : undefined,
        notes: form.userNotes || form.notes || '',
        userNotes: form.userNotes || form.notes || '',
        signalId: prefill?._id || undefined
      };

      if (editingId) {
        await journalApi.update(editingId, payload);
      } else {
        await journalApi.create(payload);
      }

      setForm(EMPTY_FORM);
      setEditingId(null);
      loadEntries();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save journal entry.');
    } finally {
      setSaving(false);
    }
  };

  const startEdit = entry => {
    setEditingId(entry._id);
    setForm({
      symbol: entry.symbol || '',
      direction: entry.direction || 'long',
      entry: entry.entry ?? '',
      exit: entry.exit ?? '',
      lotSize: entry.lotSize ?? '',
      outcome: entry.outcome || 'open',
      outcomeR: entry.outcomeR ?? '',
      pnl: entry.pnl ?? '',
      notes: entry.notes || '',
      userNotes: entry.userNotes || entry.notes || '',
      tradeRating: entry.tradeRating ?? '',
      emotion: entry.emotion || '',
      lessonsLearned: entry.lessonsLearned || '',
      screenshotUrl: entry.screenshotUrl || '',
      executionNotes: entry.executionNotes || ''
    });
  };

  const handleDelete = async id => {
    if (!window.confirm('Delete this journal entry?')) return;
    try {
      await journalApi.remove(id);
      loadEntries();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to delete entry.');
    }
  };

  return (
    <div className="insights-section">
      <div className="insights-section-header">
        <h3>Trade Journal</h3>
        <p>
          Per-signal notes, rating, emotion, lessons, and execution context. Prefill from Signal
          History after TradingView webhooks arrive, or add entries manually.
        </p>
      </div>

      {error && <div className="feature-lock">{error}</div>}

      <form className="journal-form" onSubmit={handleSubmit}>
        <div className="journal-form-grid">
          <input
            required
            placeholder="Symbol"
            value={form.symbol}
            onChange={e => setForm(f => ({ ...f, symbol: e.target.value }))}
            aria-label="Symbol"
          />
          <select
            value={form.direction}
            onChange={e => setForm(f => ({ ...f, direction: e.target.value }))}
            aria-label="Direction"
          >
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
          <input
            type="number"
            step="0.00001"
            placeholder="Entry"
            value={form.entry}
            onChange={e => setForm(f => ({ ...f, entry: e.target.value }))}
            aria-label="Entry"
          />
          <input
            type="number"
            step="0.00001"
            placeholder="Exit"
            value={form.exit}
            onChange={e => setForm(f => ({ ...f, exit: e.target.value }))}
            aria-label="Exit"
          />
          <input
            type="number"
            step="0.01"
            placeholder="Lot size"
            value={form.lotSize}
            onChange={e => setForm(f => ({ ...f, lotSize: e.target.value }))}
            aria-label="Lot size"
          />
          <select
            value={form.outcome}
            onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))}
            aria-label="Outcome"
          >
            <option value="open">Open</option>
            <option value="win">Win</option>
            <option value="loss">Loss</option>
            <option value="breakeven">Breakeven</option>
          </select>
          <input
            type="number"
            step="0.1"
            placeholder="Outcome R"
            value={form.outcomeR}
            onChange={e => setForm(f => ({ ...f, outcomeR: e.target.value }))}
            aria-label="Outcome R"
          />
          <input
            type="number"
            step="0.01"
            placeholder="PnL"
            value={form.pnl}
            onChange={e => setForm(f => ({ ...f, pnl: e.target.value }))}
            aria-label="PnL"
          />
          <select
            value={form.tradeRating}
            onChange={e => setForm(f => ({ ...f, tradeRating: e.target.value }))}
            aria-label="Trade rating"
          >
            <option value="">Trade rating</option>
            <option value="1">Poor</option>
            <option value="2">Fair</option>
            <option value="3">Good</option>
            <option value="4">Very Good</option>
            <option value="5">Excellent</option>
          </select>
          <input
            placeholder="Emotion"
            value={form.emotion}
            onChange={e => setForm(f => ({ ...f, emotion: e.target.value }))}
            aria-label="Emotion"
          />
          <input
            placeholder="Screenshot URL"
            value={form.screenshotUrl}
            onChange={e => setForm(f => ({ ...f, screenshotUrl: e.target.value }))}
            aria-label="Screenshot URL"
          />
        </div>
        <textarea
          placeholder="User notes"
          value={form.userNotes}
          onChange={e => setForm(f => ({ ...f, userNotes: e.target.value }))}
          rows={2}
          aria-label="User notes"
        />
        <textarea
          placeholder="Lessons learned"
          value={form.lessonsLearned}
          onChange={e => setForm(f => ({ ...f, lessonsLearned: e.target.value }))}
          rows={2}
          aria-label="Lessons learned"
        />
        <textarea
          placeholder="Execution notes"
          value={form.executionNotes}
          onChange={e => setForm(f => ({ ...f, executionNotes: e.target.value }))}
          rows={2}
          aria-label="Execution notes"
        />
        <div className="journal-form-actions">
          <button type="submit" className="btn-fetch" disabled={saving}>
            {saving ? 'Saving…' : editingId ? 'Update entry' : 'Add entry'}
          </button>
          {editingId && (
            <button
              type="button"
              className="btn-small"
              onClick={() => {
                setEditingId(null);
                setForm(EMPTY_FORM);
              }}
            >
              Cancel edit
            </button>
          )}
        </div>
      </form>

      {loading ? (
        <div className="loading-state">Loading journal…</div>
      ) : (
        <>
          <div className="insights-journal-cards">
            {entries.length === 0 ? (
              <div className="insights-empty">No journal entries yet.</div>
            ) : (
              entries.map(entry => (
                <article key={entry._id} className="insights-journal-card">
                  <div className="insights-journal-card-top">
                    <strong>{entry.symbol}</strong>
                    <span>{(entry.direction || '—').toUpperCase()}</span>
                    <span className="insights-journal-outcome">{entry.outcome}</span>
                  </div>
                  <dl className="insights-signal-meta">
                    <div>
                      <dt>Rating</dt>
                      <dd>{entry.tradeRating ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>Emotion</dt>
                      <dd>{entry.emotion || '—'}</dd>
                    </div>
                    <div>
                      <dt>R</dt>
                      <dd>{entry.outcomeR != null ? `${entry.outcomeR}R` : '—'}</dd>
                    </div>
                    <div>
                      <dt>Notes</dt>
                      <dd>{entry.userNotes || entry.notes || '—'}</dd>
                    </div>
                    <div>
                      <dt>Lessons</dt>
                      <dd>{entry.lessonsLearned || '—'}</dd>
                    </div>
                  </dl>
                  <div className="insights-journal-card-actions">
                    <button type="button" className="btn-small" onClick={() => startEdit(entry)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn-small btn-danger"
                      onClick={() => handleDelete(entry._id)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>

          <div className="history-table insights-journal-table">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Dir</th>
                  <th>Rating</th>
                  <th>Emotion</th>
                  <th>Outcome</th>
                  <th>R</th>
                  <th>Notes</th>
                  <th>Lessons</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="empty-cell">
                      No journal entries yet.
                    </td>
                  </tr>
                ) : (
                  entries.map(entry => (
                    <tr key={entry._id}>
                      <td data-label="Symbol">{entry.symbol}</td>
                      <td data-label="Dir">{entry.direction?.toUpperCase()}</td>
                      <td data-label="Rating">{entry.tradeRating ?? '—'}</td>
                      <td data-label="Emotion">{entry.emotion || '—'}</td>
                      <td data-label="Outcome">{entry.outcome}</td>
                      <td data-label="R">{entry.outcomeR != null ? `${entry.outcomeR}R` : '—'}</td>
                      <td data-label="Notes" className="notes-cell">
                        {entry.userNotes || entry.notes}
                      </td>
                      <td data-label="Lessons" className="notes-cell">
                        {entry.lessonsLearned || '—'}
                      </td>
                      <td className="actions-cell">
                        <button type="button" className="btn-small" onClick={() => startEdit(entry)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn-small btn-danger"
                          onClick={() => handleDelete(entry._id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
