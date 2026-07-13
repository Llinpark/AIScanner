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
  notes: ''
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
      notes: prefill.tradeExplanation || prefill.notes || ''
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
      notes: entry.notes || ''
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
        <p>Log trades manually or import from signal history</p>
      </div>

      {error && <div className="feature-lock">{error}</div>}

      <form className="journal-form" onSubmit={handleSubmit}>
        <div className="journal-form-grid">
          <input
            required
            placeholder="Symbol"
            value={form.symbol}
            onChange={e => setForm(f => ({ ...f, symbol: e.target.value }))}
          />
          <select value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value }))}>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
          <input
            type="number"
            step="0.00001"
            placeholder="Entry"
            value={form.entry}
            onChange={e => setForm(f => ({ ...f, entry: e.target.value }))}
          />
          <input
            type="number"
            step="0.00001"
            placeholder="Exit"
            value={form.exit}
            onChange={e => setForm(f => ({ ...f, exit: e.target.value }))}
          />
          <input
            type="number"
            step="0.01"
            placeholder="Lot size"
            value={form.lotSize}
            onChange={e => setForm(f => ({ ...f, lotSize: e.target.value }))}
          />
          <select value={form.outcome} onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))}>
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
          />
          <input
            type="number"
            step="0.01"
            placeholder="PnL"
            value={form.pnl}
            onChange={e => setForm(f => ({ ...f, pnl: e.target.value }))}
          />
        </div>
        <textarea
          placeholder="Notes / lessons learned"
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          rows={3}
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
        <div className="history-table">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Dir</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>Outcome</th>
                <th>R</th>
                <th>PnL</th>
                <th>Notes</th>
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
                    <td>{entry.symbol}</td>
                    <td>{entry.direction?.toUpperCase()}</td>
                    <td>{entry.entry != null ? Number(entry.entry).toFixed(5) : '—'}</td>
                    <td>{entry.exit != null ? Number(entry.exit).toFixed(5) : '—'}</td>
                    <td>{entry.outcome}</td>
                    <td>{entry.outcomeR != null ? `${entry.outcomeR}R` : '—'}</td>
                    <td>{entry.pnl != null ? entry.pnl : '—'}</td>
                    <td className="notes-cell">{entry.notes}</td>
                    <td className="actions-cell">
                      <button type="button" className="btn-small" onClick={() => startEdit(entry)}>
                        Edit
                      </button>
                      <button type="button" className="btn-small btn-danger" onClick={() => handleDelete(entry._id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
