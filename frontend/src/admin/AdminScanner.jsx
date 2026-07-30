import { useEffect, useState } from 'react';
import { adminApi } from '../services/api';
import { useAuth } from '../context/AuthContext';

const LIVE_STRATEGY_KEYS = new Set(['daytrading', 'scalping']);

const FALLBACK_STRATEGY_CATALOG = [
  {
    key: 'daytrading',
    name: 'Liquidity Sweep + Fair Value Gap (Day Trading)',
    status: 'live',
    configurable: true,
    enabled: true
  },
  {
    key: 'scalping',
    name: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    status: 'live',
    configurable: true,
    enabled: true
  }
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
  { value: 'smart_scoring', label: 'Smart liquidity scoring (default)' },
  { value: 'rr', label: 'Risk/reward multiples' },
  { value: 'previous_swing', label: 'Previous swing' },
  { value: 'nearest_liquidity', label: 'Nearest liquidity' },
  { value: 'manual_rr', label: 'Manual RR' }
];

const DAY_TP_MODELS = [
  { value: 'smart_scoring', label: 'Smart liquidity scoring (default)' },
  { value: 'institutional', label: 'Institutional (swing / PDH / PWH)' },
  { value: 'rr', label: 'Risk/reward multiples' },
  { value: 'manual_rr', label: 'Manual RR' },
  { value: 'previous_swing', label: 'Previous swing' },
  { value: 'nearest_liquidity', label: 'Nearest liquidity' }
];

const DEFAULT_TP_SCORE_WEIGHTS = {
  internal_liquidity: 45,
  external_liquidity: 38,
  equal_high_low: 40,
  untapped_fvg: 35,
  swing_high_low: 30,
  order_block: 25,
  breaker_block: 22,
  mitigation_block: 22,
  pdh_pdl: 20,
  pwh_pwl: 15,
  pmh_pml: 10,
  atr_projection: 8,
  rr_fallback: 5
};

/** Scalping Strategy TP Profile weight defaults (admin UI fallback). */
const SCALPING_TP_SCORE_WEIGHTS = {
  internal_liquidity: 50,
  equal_high_low: 45,
  untapped_fvg: 40,
  swing_high_low: 35,
  external_liquidity: 25,
  order_block: 25,
  breaker_block: 22,
  mitigation_block: 22,
  pdh_pdl: 18,
  pwh_pwl: 8,
  pmh_pml: 5,
  atr_projection: 8,
  rr_fallback: 5
};

/** Day Trading Strategy TP Profile weight defaults (admin UI fallback). */
const DAYTRADING_TP_SCORE_WEIGHTS = {
  pdh_pdl: 48,
  pwh_pwl: 44,
  external_liquidity: 42,
  swing_high_low: 40,
  equal_high_low: 32,
  untapped_fvg: 30,
  internal_liquidity: 28,
  order_block: 25,
  breaker_block: 22,
  mitigation_block: 22,
  pmh_pml: 28,
  atr_projection: 8,
  rr_fallback: 5
};

const TP_SCORE_WEIGHT_FIELDS = [
  { key: 'internal_liquidity', label: 'Weight for Internal Liquidity' },
  { key: 'external_liquidity', label: 'Weight for External Liquidity' },
  { key: 'equal_high_low', label: 'Weight for Equal High/Low' },
  { key: 'swing_high_low', label: 'Weight for Swing High/Low' },
  { key: 'untapped_fvg', label: 'Weight for FVG' },
  { key: 'order_block', label: 'Weight for Order Blocks' },
  { key: 'breaker_block', label: 'Weight for Breaker Blocks' },
  { key: 'mitigation_block', label: 'Weight for Mitigation Blocks' },
  { key: 'pdh_pdl', label: 'Weight for PDH/PDL' },
  { key: 'pwh_pwl', label: 'Weight for PWH/PWL' },
  { key: 'pmh_pml', label: 'Weight for PMH/PML' },
  { key: 'atr_projection', label: 'Weight for ATR Projection' },
  { key: 'rr_fallback', label: 'Weight for Risk:Reward fallback' }
];

function isSmartTpEnabled(tp) {
  if (tp?.enableSmartTpScoring === false) return false;
  if (tp?.enableDynamicTp === false) return false;
  return true;
}

function isSmartTpModel(model) {
  const m = String(model || '').toLowerCase();
  return m === 'smart_scoring' || m === 'smart_tp' || m === 'dynamic_liquidity' || m === 'dynamic';
}

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

function LiquidityTargetScoringSection({
  strategyKey,
  takeProfit,
  atrCapsDefault,
  maxAtrDefault,
  tpModels,
  showMinRr = false,
  scoreWeightDefaults = DEFAULT_TP_SCORE_WEIGHTS,
  patchNested,
  updateStrategy
}) {
  const smartOn = isSmartTpEnabled(takeProfit);
  const weights = {
    ...scoreWeightDefaults,
    ...(takeProfit?.scoreWeights || {})
  };
  const setTp = (key, value) => patchNested(strategyKey, 'takeProfit', key, value);
  const patchTp = patch => {
    if (typeof updateStrategy === 'function') {
      updateStrategy(strategyKey, current => ({
        ...current,
        takeProfit: {
          ...(current.takeProfit || {}),
          ...patch
        }
      }));
      return;
    }
    Object.entries(patch).forEach(([key, value]) => setTp(key, value));
  };
  const setWeight = (key, value) =>
    setTp('scoreWeights', {
      ...weights,
      [key]: value
    });

  return (
    <>
      <h5 className="admin-form-subsection-title">Liquidity Target Scoring</h5>
      <Field label="Enable Smart TP Scoring" className="admin-checkbox">
        <input
          type="checkbox"
          checked={smartOn}
          onChange={e => {
            const on = e.target.checked;
            patchTp({
              enableSmartTpScoring: on,
              enableDynamicTp: on,
              ...(on ? { model: 'smart_scoring' } : {})
            });
          }}
        />
      </Field>
      <Field label="TP model (legacy selectable when scoring off)">
        <select
          className="admin-input admin-select"
          value={
            smartOn
              ? takeProfit?.model && isSmartTpModel(takeProfit.model)
                ? takeProfit.model
                : 'smart_scoring'
              : takeProfit?.model && !isSmartTpModel(takeProfit.model)
                ? takeProfit.model
                : tpModels.find(m => !isSmartTpModel(m.value))?.value || 'rr'
          }
          onChange={e => {
            const model = e.target.value;
            const smart = isSmartTpModel(model);
            patchTp({
              model,
              enableSmartTpScoring: smart,
              enableDynamicTp: smart
            });
          }}
        >
          {tpModels.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Maximum ATR multiplier">
        <input
          type="number"
          min={0}
          step={0.1}
          value={takeProfit?.maxAtrMultiplier ?? maxAtrDefault}
          onChange={e => setTp('maxAtrMultiplier', Number(e.target.value))}
        />
      </Field>
      <Field label="ATR caps TP1,TP2,TP3">
        <input
          type="text"
          value={listToCsv(takeProfit?.atrCaps || atrCapsDefault)}
          onChange={e => setTp('atrCaps', csvToList(e.target.value).map(Number))}
        />
      </Field>
      <Field label="Maximum TP distance (pips)">
        <input
          type="number"
          min={0}
          step={1}
          placeholder="Unlimited"
          value={takeProfit?.maxTpDistancePips ?? ''}
          onChange={e =>
            setTp('maxTpDistancePips', e.target.value === '' ? null : Number(e.target.value))
          }
        />
      </Field>
      <Field label="Minimum score required">
        <input
          type="number"
          min={0}
          step={1}
          value={takeProfit?.minScore ?? 0}
          onChange={e => setTp('minScore', Number(e.target.value))}
        />
      </Field>
      <Field label="Allow RR fallback" className="admin-checkbox">
        <input
          type="checkbox"
          checked={takeProfit?.allowRrFallback !== false}
          onChange={e => setTp('allowRrFallback', e.target.checked)}
        />
      </Field>
      {showMinRr ? (
        <Field label="Min RR">
          <input
            type="number"
            min={0}
            step={0.1}
            value={takeProfit?.minRr ?? 1.2}
            onChange={e => setTp('minRr', Number(e.target.value))}
          />
        </Field>
      ) : null}
      <Field label="RR multiples (comma-separated)">
        <input
          type="text"
          value={listToCsv(takeProfit?.rrMultiples)}
          onChange={e => setTp('rrMultiples', csvToList(e.target.value).map(Number))}
        />
      </Field>
      <WeightGrid
        legend="Probability weights used to rank liquidity objectives (higher = preferred)."
        fields={TP_SCORE_WEIGHT_FIELDS}
        weights={weights}
        onChange={setWeight}
        min={0}
        max={100}
        step={1}
      />
    </>
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

  const syncActiveStrategyFromConfig = config => {
    const next = config?.activeStrategy;
    if (LIVE_STRATEGY_KEYS.has(next)) {
      setActiveStrategy(next);
    }
  };

  useEffect(() => {
    if (!canManageScanner) {
      setLoading(false);
      setError('Super admin access required for scanner configuration.');
      return;
    }
    adminApi
      .getScannerConfig()
      .then(res => {
        const config = res.data.config;
        setForm(config);
        syncActiveStrategyFromConfig(config);
      })
      .catch(err => setError(err.response?.data?.message || 'Unable to load scanner config.'))
      .finally(() => setLoading(false));
  }, [canManageScanner]);

  const updateCore = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
  };

  const updateMarketRegime = (key, value) => {
    setForm(prev => ({
      ...prev,
      marketRegime: {
        ...(prev.marketRegime || {}),
        [key]: value
      }
    }));
  };

  const selectStrategyTab = strategyKey => {
    setActiveStrategy(strategyKey);
    // Only live strategies drive analyze prefer / persisted activeStrategy
    if (LIVE_STRATEGY_KEYS.has(strategyKey)) {
      setForm(prev => (prev ? { ...prev, activeStrategy: strategyKey } : prev));
    }
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
      // Persist the currently selected strategy tab alongside independent profiles
      const payload = { ...form, activeStrategy };
      const response = await adminApi.updateScannerConfig(payload);
      const config = response.data.config;
      setForm(config);
      syncActiveStrategyFromConfig(config);
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
  const strategyCatalog =
    Array.isArray(form.strategyCatalog) && form.strategyCatalog.length
      ? form.strategyCatalog
      : FALLBACK_STRATEGY_CATALOG;
  const selectedCatalogEntry =
    strategyCatalog.find(s => s.key === activeStrategy) || strategyCatalog[0] || null;
  const selectedIsLive =
    selectedCatalogEntry &&
    (selectedCatalogEntry.status === 'live' || LIVE_STRATEGY_KEYS.has(selectedCatalogEntry.key));

  return (
    <form className="admin-scanner-form admin-panel" onSubmit={handleSave}>
      <div className="admin-panel-header">
        <div>
          <h3>Scanner configuration</h3>
          <p className="admin-form-note">
            Strategy Engine profiles plug into a shared scanner. Each strategy has independent
            settings — changing one never affects another. Live strategies (Liquidity Sweep Scalping
            / Day Trading) are fully configurable; others show as coming soon. Selected live strategy
            and overrides persist to the database. TradingView webhook → TradeDelivery is unchanged.
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
        <h4 className="admin-form-section-title">Market Regime Filter</h4>
        <p className="admin-form-note">
          Pre-scan gate (independent of strategy). When enabled, symbols with unsuitable conditions
          are skipped before Liquidity Sweep / FVG analysis. Default: enabled with conservative
          thresholds (weekend FX close, high-impact news, very low ATR). Persist with Save.
        </p>
        <div className="admin-form-grid">
          <Field label="Enable Market Regime Filter" className="admin-checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.marketRegime?.enabled)}
              onChange={e => updateMarketRegime('enabled', e.target.checked)}
            />
          </Field>
          <Field label="Minimum ATR (pips)">
            <input
              type="number"
              min={0}
              step={0.5}
              value={form.marketRegime?.minAtrPips ?? 3}
              onChange={e => updateMarketRegime('minAtrPips', Number(e.target.value))}
            />
          </Field>
          <Field label="Maximum Spread (pips)">
            <input
              type="number"
              min={0.1}
              step={0.5}
              value={form.marketRegime?.maxSpreadPips ?? 25}
              onChange={e => updateMarketRegime('maxSpreadPips', Number(e.target.value))}
            />
          </Field>
          <Field label="Minimum Volatility Score">
            <input
              type="number"
              min={0}
              max={100}
              value={form.marketRegime?.minVolatilityScore ?? 20}
              onChange={e => updateMarketRegime('minVolatilityScore', Number(e.target.value))}
            />
          </Field>
          <Field label="Minimum Regime Score">
            <input
              type="number"
              min={0}
              max={100}
              value={form.marketRegime?.minRegimeScore ?? 40}
              onChange={e => updateMarketRegime('minRegimeScore', Number(e.target.value))}
            />
          </Field>
          <Field label="Avoid High Impact News" className="admin-checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.marketRegime?.avoidHighImpactNews)}
              onChange={e => updateMarketRegime('avoidHighImpactNews', e.target.checked)}
            />
          </Field>
          <Field label="Avoid Low Liquidity Sessions" className="admin-checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.marketRegime?.avoidLowLiquiditySessions)}
              onChange={e => updateMarketRegime('avoidLowLiquiditySessions', e.target.checked)}
            />
          </Field>
          <Field label="Allow Asian Session" className="admin-checkbox">
            <input
              type="checkbox"
              checked={form.marketRegime?.allowAsianSession !== false}
              onChange={e => updateMarketRegime('allowAsianSession', e.target.checked)}
            />
          </Field>
          <Field label="Allow London Session" className="admin-checkbox">
            <input
              type="checkbox"
              checked={form.marketRegime?.allowLondonSession !== false}
              onChange={e => updateMarketRegime('allowLondonSession', e.target.checked)}
            />
          </Field>
          <Field label="Allow New York Session" className="admin-checkbox">
            <input
              type="checkbox"
              checked={form.marketRegime?.allowNewYorkSession !== false}
              onChange={e => updateMarketRegime('allowNewYorkSession', e.target.checked)}
            />
          </Field>
          <Field label="Allow Session Overlap" className="admin-checkbox">
            <input
              type="checkbox"
              checked={form.marketRegime?.allowSessionOverlap !== false}
              onChange={e => updateMarketRegime('allowSessionOverlap', e.target.checked)}
            />
          </Field>
        </div>
      </section>

      <section className="admin-form-section">
        <h4 className="admin-form-section-title">Strategies</h4>
        <p className="admin-form-note">
          Strategies → select a profile → configure settings. Enable toggles apply only to live
          profiles. Prefer / active strategy for analysis:{' '}
          <strong>{LIVE_STRATEGY_KEYS.has(form.activeStrategy) ? form.activeStrategy : activeStrategy}</strong>
        </p>

        <div className="admin-strategy-toggle-row">
          {strategyCatalog.map(entry => {
            const isLive = entry.status === 'live' || LIVE_STRATEGY_KEYS.has(entry.key);
            const enabled = isLive
              ? Boolean(strategies[entry.key]?.enabled)
              : false;
            return (
              <label
                key={entry.key}
                className={`admin-strategy-chip${isLive ? '' : ' is-stub'}`}
                title={entry.description || entry.name}
              >
                {isLive ? (
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={e => updateStrategy(entry.key, { enabled: e.target.checked })}
                  />
                ) : (
                  <input type="checkbox" checked={false} disabled readOnly />
                )}
                <span>{entry.name?.replace(/^Liquidity Sweep \+ Fair Value Gap \(/, '').replace(/\)$/, '') || entry.key}</span>
                <em>{isLive ? (enabled ? 'On' : 'Off') : 'Soon'}</em>
              </label>
            );
          })}
        </div>

        <div className="admin-strategy-tabs" role="tablist" aria-label="Strategy settings">
          {strategyCatalog.map(entry => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={activeStrategy === entry.key}
              className={`admin-strategy-tab${activeStrategy === entry.key ? ' is-active' : ''}${
                entry.status === 'stub' ? ' is-stub' : ''
              }`}
              onClick={() => selectStrategyTab(entry.key)}
            >
              {entry.name?.includes('Scalping')
                ? 'Scalping'
                : entry.name?.includes('Day Trading')
                  ? 'Day Trading'
                  : entry.name?.replace(/ Strategy$/, '') || entry.key}
            </button>
          ))}
        </div>

        {!selectedIsLive && selectedCatalogEntry && (
          <div className="admin-strategy-panel admin-strategy-panel-stub" role="tabpanel">
            <h5 className="admin-form-subsection-title">{selectedCatalogEntry.name}</h5>
            <p className="admin-form-note">
              {selectedCatalogEntry.description ||
                'Coming soon — this Strategy Profile is registered but not yet implemented. Adding it later only requires a profile + registration; the Scanner Engine stays unchanged.'}
            </p>
            <div className="info-box admin-alert">
              Status: disabled stub · version {selectedCatalogEntry.version || 1}
            </div>
          </div>
        )}

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
              <LiquidityTargetScoringSection
                strategyKey="daytrading"
                takeProfit={daytrading.takeProfit}
                atrCapsDefault={[1.5, 2.5, 3.5]}
                maxAtrDefault={3.5}
                tpModels={DAY_TP_MODELS}
                showMinRr
                scoreWeightDefaults={DAYTRADING_TP_SCORE_WEIGHTS}
                patchNested={patchNested}
                updateStrategy={updateStrategy}
              />
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
              <LiquidityTargetScoringSection
                strategyKey="scalping"
                takeProfit={scalping.takeProfit}
                atrCapsDefault={[0.7, 1.3, 2.0]}
                maxAtrDefault={2.0}
                tpModels={SCALP_TP_MODELS}
                scoreWeightDefaults={SCALPING_TP_SCORE_WEIGHTS}
                patchNested={patchNested}
                updateStrategy={updateStrategy}
              />
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
