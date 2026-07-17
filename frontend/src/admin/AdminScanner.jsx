import { useEffect, useState } from 'react';
import { adminApi } from '../services/api';

const WEIGHT_FIELDS = [
  { key: 'liquiditySweep', label: 'Liquidity sweep' },
  { key: 'fvgRule', label: 'Valid FVG' },
  { key: 'htfBias', label: 'HTF alignment' },
  { key: 'fvgUnmitigated', label: 'FVG unmitigated' },
  { key: 'marketStructureShift', label: 'Market structure shift' },
  { key: 'expansionCandle', label: 'Expansion candle' }
];

export default function AdminScanner() {
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    adminApi
      .getScannerConfig()
      .then(res => setForm(res.data.config))
      .catch(err => setError(err.response?.data?.message || 'Unable to load scanner config.'))
      .finally(() => setLoading(false));
  }, []);

  const updateField = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const updateWeight = (key, value) => {
    setForm(prev => ({
      ...prev,
      weights: {
        ...prev.weights,
        [key]: value
      }
    }));
  };

  const handleSave = async event => {
    event.preventDefault();
    if (!form) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const response = await adminApi.updateScannerConfig(form);
      setForm(response.data.config);
      setMessage(response.data.message || 'Scanner configuration saved.');
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to save scanner config.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="loading-state">Loading scanner settings…</div>;
  }

  if (!form) {
    return <div className="feature-lock">{error || 'Scanner config unavailable.'}</div>;
  }

  return (
    <form className="admin-scanner-form admin-panel" onSubmit={handleSave}>
      <div className="admin-panel-header">
        <div>
          <h3>Scanner configuration</h3>
          <p className="admin-form-note">
            Changes apply immediately at runtime. Mirror important values in <code>backend/.env</code> if you want
            them to survive a backend restart.
          </p>
        </div>
      </div>

      <section className="admin-form-section">
        <h4 className="admin-form-section-title">Core settings</h4>
        <div className="admin-form-grid">
          <label className="admin-field">
            <span>Premium threshold (%)</span>
            <input
              type="number"
              min={50}
              max={100}
              value={form.premiumThreshold}
              onChange={e => updateField('premiumThreshold', Number(e.target.value))}
            />
          </label>

          <label className="admin-field">
            <span>Scan interval (ms)</span>
            <input
              type="number"
              min={60000}
              step={1000}
              value={form.autoScanIntervalMs}
              onChange={e => updateField('autoScanIntervalMs', Number(e.target.value))}
            />
          </label>

          <label className="admin-field">
            <span>Batch size (symbols per cycle)</span>
            <input
              type="number"
              min={1}
              max={15}
              value={form.scanBatchSize}
              onChange={e => updateField('scanBatchSize', Number(e.target.value))}
            />
          </label>

          <label className="admin-field admin-checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.autoScanEnabled)}
              onChange={e => updateField('autoScanEnabled', e.target.checked)}
            />
            <span>Auto-scan enabled</span>
          </label>
        </div>
      </section>

      <fieldset className="admin-weight-grid">
        <legend>Quality factor weights (decimal, should sum to ~1.0)</legend>
        {WEIGHT_FIELDS.map(field => (
          <label key={field.key} className="admin-field">
            <span>{field.label}</span>
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={form.weights?.[field.key] ?? 0}
              onChange={e => updateWeight(field.key, Number(e.target.value))}
            />
          </label>
        ))}
      </fieldset>

      {message && <div className="info-box admin-alert admin-alert-success">{message}</div>}
      {error && <div className="feature-lock admin-alert admin-alert-error">{error}</div>}

      <div className="admin-form-actions">
        <button type="submit" className="hero-btn hero-btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save scanner settings'}
        </button>
      </div>
    </form>
  );
}
