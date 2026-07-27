import { useEffect, useState } from 'react';
import { adminApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

const STRATEGY_TABS = [
  { id: 'daytrading', label: 'Day Trading' },
  { id: 'scalping', label: 'Scalping' },
  { id: 'legacy', label: 'Classic / Legacy' }
];

const SCALPING_WEIGHT_FIELDS = [
  { key: 'sweep', label: 'Liquidity sweep' },
  { key: 'mss', label: 'Market structure shift' },
  { key: 'displacement', label: 'Displacement' },
  { key: 'fvg', label: 'Fair value gap' },
  { key: 'retrace', label: 'Retracement' },
  { key: 'engulfing', label: 'Engulfing' },
  { key: 'doji', label: 'Doji / clean FVG' }
];

const DAYTRADING_WEIGHT_FIELDS = [
  { key: 'htfBias', label: 'HTF bias' },
  { key: 'sweep', label: 'Liquidity sweep' },
  { key: 'mss', label: 'Market structure shift' },
  { key: 'displacement', label: 'Displacement' },
  { key: 'fvg', label: 'Fair value gap' },
  { key: 'retrace', label: 'Retracement' },
  { key: 'optionalConfirmation', label: 'Optional confirmation' }
];

const LEGACY_WEIGHT_FIELDS = [
  { key: 'liquiditySweep', label: 'Liquidity sweep' },
  { key: 'fvgRule', label: 'Valid FVG' },
  { key: 'htfBias', label: 'HTF alignment' },
  { key: 'fvgUnmitigated', label: 'FVG unmitigated' },
  { key: 'marketStructureShift', label: 'Market structure shift' },
  { key: 'expansionCandle', label: 'Expansion candle' }
];

const ENTRY_MODELS = [
  { value: 'ce', label: 'CE (50%)' },
  { value: 'entire', label: 'Entire FVG' },
  { value: 'upper_half', label: 'Upper half' },
  { value: 'lower_half', label: 'Lower half' }
];

const STOP_MODELS = [
  { value: 'sweep', label: 'Beyond sweep' },
  { value: 'fvg', label: 'Beyond FVG' },
  { value: 'sweep_or_fvg', label: 'Sweep or FVG (protective)' }
];

const SCALP_TP_MODELS = [
  { value: 'rr', label: 'Risk/reward multiples' },
  { value: 'previous_swing', label: 'Previous swing' },
  { value: 'nearest_liquidity', label: 'Nearest liquidity' },
  { value: 'manual_rr', label: 'Manual RR' }
];

const DAY_TP_MODELS = [
  { value: 'institutional', label: 'Institutional (swing / PDH / PWH)' },
  { value: 'rr', label: 'Risk/reward multiples' },
  { value: 'manual_rr', label: 'Manual RR' },
  { value: 'previous_swing', label: 'Previous swing' },
  { value: 'nearest_liquidity', label: 'Nearest liquidity' }
];

function listToCsv(value) {
  if (Array.isArray(value)) return value.join(',');
  return value == null ? '' : String(value);
}

function csvToList(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function Field({ label, children, className = '' }) {
  if (className.includes('admin-checkbox')) {
    return (
      <label className={`admin-field ${className}`.trim()}>
        {children}
        <span>{label}</span>
      </label>
    );
  }
  return (
    <label className={`admin-field ${className}`.trim()}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function WeightGrid({ legend, fields, weights, onChange, min = 0, max = 100, step = 1 }) {
  const sum = fields.reduce((acc, f) => acc + (Number(weights?.[f.key]) || 0), 0);
  const sumLabel = max <= 1 ? sum.toFixed(2) : String(sum);
  return (
    <fieldset className="admin-weight-grid">
      <legend>
        {legend} <em className="admin-weight-sum">(sum {sumLabel})</em>
      </legend>
      {fields.map(field => (
        <Field key={field.key} label={field.label}>
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={weights?.[field.key] ?? 0}
            onChange={e => onChange(field.key, Number(e.target.value))}
          />
        </Field>
      ))}
    </fieldset>
  );
}

export default function AdminScanner() {
  const { user } = useAuth();
  const canManageScanner = Boolean(user?.isSuperAdmin || user?.canManageScannerConfig);
  const [form, setForm] = useState(null);
  const [activeStrategy, setActiveStrategy] = useState('daytrading');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!canManageScanner) {
      setLoading(false);
      setError('Super admin access required for scanner configuration.');
      return;
    }
    adminApi
      .getScannerConfig()
      .then(res => setForm(res.data.config))
      .catch(err => setError(err.response?.data?.message || 'Unable to load scanner config.'))
      .finally(() => setLoading(false));
  }, [canManageScanner]);

  const updateCore = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const updateLegacyWeight = (key, value) => {
    setForm(prev => ({
      ...prev,
      weights: { ...prev.weights, [key]: value }
    }));
  };

  const updateStrategy = (strategyKey, updater) => {
    setForm(prev => {
      const current = prev.strategies?.[strategyKey] || {};
      const next =
        typeof updater === 'function' ? updater(current) : { ...current, ...updater };
      return {
        ...prev,
        strategies: {
          ...prev.strategies,
          [strategyKey]: next
        }
      };
    });
  };

  const patchNested = (strategyKey, section, key, value) => {
    updateStrategy(strategyKey, current => ({
      ...current,
      [section]: {
        ...(current[section] || {}),
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

  const strategies = form.strategies || {};
  const scalping = strategies.scalping || {};
  const daytrading = strategies.daytrading || {};
  const legacy = strategies.legacy || {};

  return (
    <form className="admin-scanner-form admin-panel" onSubmit={handleSave}>
      <div className="admin-panel-header">
        <div>
          <h3>Scanner configuration</h3>
          <p className="admin-form-note">
            Configure pluggable strategies used by the Liquidity Sweep + FVG pipeline. Strategy
            overrides are saved to the database. Core scan interval / batch settings apply at
            runtime (mirror in <code>backend/.env</code> to survive restarts). TradingView webhook →
            TradeDelivery is unchanged.
          </p>
        </div>
      </div>

      <section className="admin-form-section">
        <h4 className="admin-form-section-title">Core scan settings</h4>
        <div className="admin-form-grid">
          <Field label="Scan interval (ms)">
            <input
              type="number"
              min={60000}
              step={1000}
              value={form.autoScanIntervalMs}
              onChange={e => updateCore('autoScanIntervalMs', Number(e.target.value))}
            />
          </Field>
          <Field label="Batch size (symbols per cycle)">
            <input
              type="number"
              min={1}
              max={15}
              value={form.scanBatchSize}
              onChange={e => updateCore('scanBatchSize', Number(e.target.value))}
            />
          </Field>
          <Field label="Auto-scan enabled" className="admin-checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.autoScanEnabled)}
              onChange={e => updateCore('autoScanEnabled', e.target.checked)}
            />
          </Field>
        </div>
      </section>

      <section className="admin-form-section">
        <h4 className="admin-form-section-title">Strategies</h4>
        <div className="admin-strategy-toggle-row">
          <label className="admin-strategy-chip">
            <input
              type="checkbox"
              checked={Boolean(daytrading.enabled)}
              onChange={e => updateStrategy('daytrading', { enabled: e.target.checked })}
            />
            <span>Day Trading</span>
            <em>{daytrading.enabled ? 'On' : 'Off'}</em>
          </label>
          <label className="admin-strategy-chip">
            <input
              type="checkbox"
              checked={Boolean(scalping.enabled)}
              onChange={e => updateStrategy('scalping', { enabled: e.target.checked })}
            />
            <span>Scalping</span>
            <em>{scalping.enabled ? 'On' : 'Off'}</em>
          </label>
          <label className="admin-strategy-chip">
            <input
              type="checkbox"
              checked={Boolean(legacy.enabled)}
              onChange={e => updateStrategy('legacy', { enabled: e.target.checked })}
            />
            <span>Classic / Legacy SMC</span>
            <em>{legacy.enabled ? 'On' : 'Off'}</em>
          </label>
        </div>

        <div className="admin-strategy-tabs" role="tablist" aria-label="Strategy settings">
          {STRATEGY_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeStrategy === tab.id}
              className={`admin-strategy-tab${activeStrategy === tab.id ? ' is-active' : ''}`}
              onClick={() => setActiveStrategy(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeStrategy === 'daytrading' && (
          <div className="admin-strategy-panel" role="tabpanel">
            <p className="admin-form-note">
              Liquidity Sweep + FVG day trading — HTF bias on {daytrading.htfTimeframe || '4h'},
              entries on 15m / 5m.
            </p>
            <div className="admin-form-grid">
              <Field label="HTF timeframe">
                <input
                  type="text"
                  value={daytrading.htfTimeframe || ''}
                  onChange={e => updateStrategy('daytrading', { htfTimeframe: e.target.value })}
                />
              </Field>
              <Field label="Refine HTF">
                <input
                  type="text"
                  value={daytrading.refineHtfTimeframe || ''}
                  onChange={e =>
                    updateStrategy('daytrading', { refineHtfTimeframe: e.target.value })
                  }
                />
              </Field>
              <Field label="Use refine HTF" className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(daytrading.useRefineHtf)}
                  onChange={e => updateStrategy('daytrading', { useRefineHtf: e.target.checked })}
                />
              </Field>
              <Field label="Entry timeframes (comma-separated)">
                <input
                  type="text"
                  value={listToCsv(daytrading.entryTimeframes)}
                  onChange={e =>
                    updateStrategy('daytrading', { entryTimeframes: csvToList(e.target.value) })
                  }
                />
              </Field>
              <Field label="Default entry TF">
                <input
                  type="text"
                  value={daytrading.defaultEntryTimeframe || ''}
                  onChange={e =>
                    updateStrategy('daytrading', { defaultEntryTimeframe: e.target.value })
                  }
                />
              </Field>
              <Field label="Confidence threshold (0–100)">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={daytrading.confidence?.threshold ?? 70}
                  onChange={e =>
                    patchNested('daytrading', 'confidence', 'threshold', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Entry model">
                <select
                  className="admin-input admin-select"
                  value={daytrading.entry?.model || 'ce'}
                  onChange={e => patchNested('daytrading', 'entry', 'model', e.target.value)}
                >
                  {ENTRY_MODELS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Retrace wait (bars)">
                <input
                  type="number"
                  min={4}
                  value={daytrading.entry?.maxWaitBars ?? 16}
                  onChange={e =>
                    patchNested('daytrading', 'entry', 'maxWaitBars', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Stop model">
                <select
                  className="admin-input admin-select"
                  value={daytrading.stop?.model || 'sweep'}
                  onChange={e => patchNested('daytrading', 'stop', 'model', e.target.value)}
                >
                  {STOP_MODELS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="SL buffer (ATR ratio)">
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={daytrading.stop?.bufferAtrRatio ?? 0.08}
                  onChange={e =>
                    patchNested('daytrading', 'stop', 'bufferAtrRatio', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Max stop (ATR mult)">
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={daytrading.stop?.maxStopAtrMult ?? 2.5}
                  onChange={e =>
                    patchNested('daytrading', 'stop', 'maxStopAtrMult', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="TP model">
                <select
                  className="admin-input admin-select"
                  value={daytrading.takeProfit?.model || 'institutional'}
                  onChange={e => patchNested('daytrading', 'takeProfit', 'model', e.target.value)}
                >
                  {DAY_TP_MODELS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Min RR">
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={daytrading.takeProfit?.minRr ?? 2}
                  onChange={e =>
                    patchNested('daytrading', 'takeProfit', 'minRr', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="RR multiples (comma-separated)">
                <input
                  type="text"
                  value={listToCsv(daytrading.takeProfit?.rrMultiples)}
                  onChange={e =>
                    patchNested(
                      'daytrading',
                      'takeProfit',
                      'rrMultiples',
                      csvToList(e.target.value).map(Number)
                    )
                  }
                />
              </Field>
              <Field label="Min FVG / ATR">
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={daytrading.fvg?.minGapToAtrRatio ?? 0.15}
                  onChange={e =>
                    patchNested('daytrading', 'fvg', 'minGapToAtrRatio', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Max spread (pips)">
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={daytrading.filters?.maxSpreadPips ?? 4}
                  onChange={e =>
                    patchNested('daytrading', 'filters', 'maxSpreadPips', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Min ATR (pips)">
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={daytrading.filters?.minAtrPips ?? 4}
                  onChange={e =>
                    patchNested('daytrading', 'filters', 'minAtrPips', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="News window (minutes)">
                <input
                  type="number"
                  min={0}
                  value={daytrading.filters?.newsWindowMinutes ?? 60}
                  onChange={e =>
                    patchNested(
                      'daytrading',
                      'filters',
                      'newsWindowMinutes',
                      Number(e.target.value)
                    )
                  }
                />
              </Field>
              <Field label="Reject on major news" className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(daytrading.filters?.rejectOnMajorNews)}
                  onChange={e =>
                    patchNested('daytrading', 'filters', 'rejectOnMajorNews', e.target.checked)
                  }
                />
              </Field>
              <Field label="Trade reversals" className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(daytrading.filters?.tradeReversals)}
                  onChange={e =>
                    patchNested('daytrading', 'filters', 'tradeReversals', e.target.checked)
                  }
                />
              </Field>
            </div>
            <WeightGrid
              legend="Day Trading confidence weights (points, typically sum ~100)"
              fields={DAYTRADING_WEIGHT_FIELDS}
              weights={daytrading.confidence?.weights}
              onChange={(key, value) =>
                updateStrategy('daytrading', current => ({
                  ...current,
                  confidence: {
                    ...(current.confidence || {}),
                    weights: { ...(current.confidence?.weights || {}), [key]: value }
                  }
                }))
              }
            />
          </div>
        )}

        {activeStrategy === 'scalping' && (
          <div className="admin-strategy-panel" role="tabpanel">
            <p className="admin-form-note">
              Liquidity Sweep + FVG scalping — HTF context on {scalping.htfTimeframe || '15m'},
              entries on 3m / 1m.
            </p>
            <div className="admin-form-grid">
              <Field label="HTF timeframe">
                <input
                  type="text"
                  value={scalping.htfTimeframe || ''}
                  onChange={e => updateStrategy('scalping', { htfTimeframe: e.target.value })}
                />
              </Field>
              <Field label="Entry timeframes (comma-separated)">
                <input
                  type="text"
                  value={listToCsv(scalping.entryTimeframes)}
                  onChange={e =>
                    updateStrategy('scalping', { entryTimeframes: csvToList(e.target.value) })
                  }
                />
              </Field>
              <Field label="Default entry TF">
                <input
                  type="text"
                  value={scalping.defaultEntryTimeframe || ''}
                  onChange={e =>
                    updateStrategy('scalping', { defaultEntryTimeframe: e.target.value })
                  }
                />
              </Field>
              <Field label="Confidence threshold (0–100)">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={scalping.confidence?.threshold ?? 70}
                  onChange={e =>
                    patchNested('scalping', 'confidence', 'threshold', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Entry model">
                <select
                  className="admin-input admin-select"
                  value={scalping.entry?.model || 'ce'}
                  onChange={e => patchNested('scalping', 'entry', 'model', e.target.value)}
                >
                  {ENTRY_MODELS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Retrace wait (bars)">
                <input
                  type="number"
                  min={3}
                  value={scalping.entry?.maxWaitBars ?? 10}
                  onChange={e =>
                    patchNested('scalping', 'entry', 'maxWaitBars', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Stop model">
                <select
                  className="admin-input admin-select"
                  value={scalping.stop?.model || 'sweep'}
                  onChange={e => patchNested('scalping', 'stop', 'model', e.target.value)}
                >
                  {STOP_MODELS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="SL buffer (ATR ratio)">
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={scalping.stop?.bufferAtrRatio ?? 0.05}
                  onChange={e =>
                    patchNested('scalping', 'stop', 'bufferAtrRatio', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="TP model">
                <select
                  className="admin-input admin-select"
                  value={scalping.takeProfit?.model || 'rr'}
                  onChange={e => patchNested('scalping', 'takeProfit', 'model', e.target.value)}
                >
                  {SCALP_TP_MODELS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="RR multiples (comma-separated)">
                <input
                  type="text"
                  value={listToCsv(scalping.takeProfit?.rrMultiples)}
                  onChange={e =>
                    patchNested(
                      'scalping',
                      'takeProfit',
                      'rrMultiples',
                      csvToList(e.target.value).map(Number)
                    )
                  }
                />
              </Field>
              <Field label="Min FVG / ATR">
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={scalping.fvg?.minGapToAtrRatio ?? 0.12}
                  onChange={e =>
                    patchNested('scalping', 'fvg', 'minGapToAtrRatio', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Max spread (pips)">
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={scalping.filters?.maxSpreadPips ?? 3.5}
                  onChange={e =>
                    patchNested('scalping', 'filters', 'maxSpreadPips', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Min ATR (pips)">
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={scalping.filters?.minAtrPips ?? 2}
                  onChange={e =>
                    patchNested('scalping', 'filters', 'minAtrPips', Number(e.target.value))
                  }
                />
              </Field>
              <Field label="Reject on major news" className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={Boolean(scalping.filters?.rejectOnMajorNews)}
                  onChange={e =>
                    patchNested('scalping', 'filters', 'rejectOnMajorNews', e.target.checked)
                  }
                />
              </Field>
            </div>
            <WeightGrid
              legend="Scalping confidence weights (points, typically sum ~100)"
              fields={SCALPING_WEIGHT_FIELDS}
              weights={scalping.confidence?.weights}
              onChange={(key, value) =>
                updateStrategy('scalping', current => ({
                  ...current,
                  confidence: {
                    ...(current.confidence || {}),
                    weights: { ...(current.confidence?.weights || {}), [key]: value }
                  }
                }))
              }
            />
          </div>
        )}

        {activeStrategy === 'legacy' && (
          <div className="admin-strategy-panel" role="tabpanel">
            <p className="admin-form-note">
              Classic SMC pipeline adapter (legacy). Premium threshold and quality factor weights
              apply only when this strategy is enabled.
            </p>
            <div className="admin-form-grid">
              <Field label="Premium threshold (%)">
                <input
                  type="number"
                  min={50}
                  max={100}
                  value={form.premiumThreshold}
                  onChange={e => updateCore('premiumThreshold', Number(e.target.value))}
                />
              </Field>
            </div>
            <WeightGrid
              legend="Legacy quality factor weights (decimal, should sum to ~1.0)"
              fields={LEGACY_WEIGHT_FIELDS}
              weights={form.weights}
              onChange={updateLegacyWeight}
              min={0}
              max={1}
              step={0.01}
            />
          </div>
        )}
      </section>

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
