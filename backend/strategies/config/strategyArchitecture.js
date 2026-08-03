/**
 * Canonical Strategy Architecture — single source of truth for timeframe
 * layouts used by strategy configs, Pine generator, admin, validation, and docs.
 *
 * Does NOT define sweep/FVG/BOS math, entry models, confidence scoring, or risk.
 * Future strategies (Swing, Position, Crypto, Gold) register here without
 * touching Pine strategy math.
 */

/** @typedef {'scalping'|'daytrading'|string} StrategyArchKey */

const TF_MINUTES = Object.freeze({
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '45m': 45,
  '1h': 60,
  '2h': 120,
  '3h': 180,
  '4h': 240,
  '1D': 1440,
  '1W': 10080,
  '1M': 43200
});

/**
 * @param {string} tf
 * @returns {number|null} minutes, or null if unknown
 */
function tfToMinutes(tf) {
  const raw = String(tf || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (Object.prototype.hasOwnProperty.call(TF_MINUTES, raw)) return TF_MINUTES[raw];
  // Pine-style numeric minutes / hours
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const m = raw.match(/^(\d+)\s*m$/);
  if (m) return Number(m[1]);
  const h = raw.match(/^(\d+)\s*h$/);
  if (h) return Number(h[1]) * 60;
  const d = raw.match(/^(\d+)\s*d$/);
  if (d) return Number(d[1]) * 1440;
  return null;
}

/**
 * Convert app TF (15m, 1h, 4h) → TradingView Pine input.timeframe value ("15", "60", "240").
 * @param {string} tf
 * @returns {string}
 */
function tfToPine(tf) {
  const minutes = tfToMinutes(tf);
  if (minutes == null) {
    return String(tf || '')
      .replace(/m$/i, '')
      .replace(/^(\d+)h$/i, (_, n) => String(Number(n) * 60));
  }
  return String(minutes);
}

/**
 * @param {string} tf
 * @returns {number|null} seconds
 */
function tfToSeconds(tf) {
  const minutes = tfToMinutes(tf);
  return minutes == null ? null : minutes * 60;
}

/**
 * True when `tf` matches any HTF in the list (app form "15m"/"1h" or Pine minutes "15"/"60").
 * Used to enforce "never enter on HTF" without hardcoding per-strategy TF strings.
 * @param {string} tf
 * @param {string[]} htfTimeframes
 */
function isHtfChartTimeframe(tf, htfTimeframes = []) {
  const minutes = tfToMinutes(tf);
  if (minutes == null) return false;
  return (htfTimeframes || []).some(h => tfToMinutes(h) === minutes);
}

/**
 * Human label for TF lists, e.g. ["3m","5m"] → "3m or 5m"
 * @param {string[]} tfs
 */
function formatTfList(tfs) {
  const list = (tfs || []).map(String);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} or ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, or ${list[list.length - 1]}`;
}

/**
 * Human HTF label for Pine UI (15m → 15 Minutes, 1h → 1 Hour).
 * @param {string} tf
 */
function formatHtfDisplay(tf) {
  const minutes = tfToMinutes(tf);
  if (minutes == null) return String(tf);
  if (minutes < 60) return `${minutes} Minutes`;
  if (minutes === 60) return '1 Hour';
  if (minutes % 60 === 0) return `${minutes / 60} Hour`;
  return String(tf);
}

/**
 * Canonical architecture definitions.
 * Add Swing / Position / Crypto / Gold here — Pine math stays in templates.
 */
const STRATEGY_ARCHITECTURE = Object.freeze({
  scalping: Object.freeze({
    key: 'scalping',
    id: 'liquidity_sweep_fvg_scalp',
    name: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    shortLabel: 'Scalping',
    pineShortTitle: 'Kaching Scalp',
    pineTitle: 'KachingFx Sweep+FVG Scalp',
    /** Allowed entry chart timeframes (TradingView chart TF). */
    entryTimeframes: Object.freeze(['3m', '5m']),
    defaultEntryTimeframe: '3m',
    /** Allowed HTF confirmation timeframes (via request.security only). */
    htfTimeframes: Object.freeze(['15m']),
    defaultHtfTimeframe: '15m',
    /** Optional refine HTF (unused for scalping). */
    refineHtfTimeframes: Object.freeze([]),
    defaultRefineHtfTimeframe: null,
    useRefineHtfDefault: false,
    /** Env override keys for TF fields. */
    env: Object.freeze({
      entryTfs: 'SCALPING_ENTRY_TFS',
      defaultEntry: 'SCALPING_DEFAULT_ENTRY_TF',
      htf: 'SCALPING_HTF_TF'
    }),
    /** Diagnostic labels shown in Pine when TF validation fails. */
    diagnostics: Object.freeze({
      wrongEntry: 'Wrong Entry Timeframe',
      wrongHtf: 'Wrong HTF Configuration',
      chartIsHtf: 'Chart opened on HTF',
      unsupported: 'Unsupported Strategy Configuration',
      missingHtf: 'Missing HTF Confirmation'
    })
  }),
  daytrading: Object.freeze({
    key: 'daytrading',
    id: 'liquidity_sweep_fvg_daytrading',
    name: 'Liquidity Sweep + Fair Value Gap (Day Trading)',
    shortLabel: 'Day Trading',
    pineShortTitle: 'Kaching Day',
    pineTitle: 'KachingFx Sweep+FVG Day',
    entryTimeframes: Object.freeze(['5m', '15m']),
    defaultEntryTimeframe: '15m',
    htfTimeframes: Object.freeze(['1h', '4h']),
    defaultHtfTimeframe: '1h',
    refineHtfTimeframes: Object.freeze(['1h', '4h']),
    defaultRefineHtfTimeframe: '1h',
    useRefineHtfDefault: false,
    env: Object.freeze({
      entryTfs: 'DAYTRADING_ENTRY_TFS',
      defaultEntry: 'DAYTRADING_DEFAULT_ENTRY_TF',
      htf: 'DAYTRADING_HTF_TF',
      refineHtf: 'DAYTRADING_REFINE_HTF_TF'
    }),
    diagnostics: Object.freeze({
      wrongEntry: 'Wrong Entry Timeframe',
      wrongHtf: 'Wrong HTF Configuration',
      chartIsHtf: 'Chart opened on HTF',
      unsupported: 'Unsupported Strategy Configuration',
      missingHtf: 'Missing HTF Confirmation'
    })
  })
});

/** Reserved keys for future strategies — architecture-only stubs (not live). */
const FUTURE_STRATEGY_KEYS = Object.freeze(['swing', 'position', 'crypto', 'gold']);

/**
 * @param {string} key
 * @returns {typeof STRATEGY_ARCHITECTURE[keyof typeof STRATEGY_ARCHITECTURE]|null}
 */
function getStrategyArchitecture(key) {
  const k = String(key || '')
    .toLowerCase()
    .trim();
  if (k === 'scalp' || k === 'liquidity_sweep_fvg_scalp' || k === 'sweep_fvg_scalp') {
    return STRATEGY_ARCHITECTURE.scalping;
  }
  if (
    k === 'day' ||
    k === 'liquidity_sweep_fvg_daytrading' ||
    k === 'sweep_fvg' ||
    k === 'sweep_fvg_daytrading'
  ) {
    return STRATEGY_ARCHITECTURE.daytrading;
  }
  return STRATEGY_ARCHITECTURE[k] || null;
}

/**
 * Parse CSV / array of TFs, keeping only those in the allowlist (order preserved from allowlist).
 * @param {string|string[]} value
 * @param {string[]} allowlist
 * @param {string[]} fallback
 */
function parseAllowedTimeframes(value, allowlist, fallback) {
  const allow = new Set((allowlist || []).map(String));
  let raw = [];
  if (Array.isArray(value)) {
    raw = value.map(v => String(v).trim()).filter(Boolean);
  } else if (typeof value === 'string') {
    raw = value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
  const filtered = raw.filter(tf => allow.has(tf));
  if (!filtered.length) return [...(fallback || allowlist || [])];
  // Stable order matching allowlist
  return (allowlist || []).filter(tf => filtered.includes(tf));
}

/**
 * Resolve TF fields for a strategy from env + optional overrides, clamped to architecture.
 * @param {StrategyArchKey} key
 * @param {Object} [overrides]
 */
function resolveArchitectureTimeframes(key, overrides = {}) {
  const arch = getStrategyArchitecture(key);
  if (!arch) {
    throw new Error(`Unknown strategy architecture: ${key}`);
  }

  const envEntry =
    arch.env.entryTfs && process.env[arch.env.entryTfs]
      ? process.env[arch.env.entryTfs]
      : arch.entryTimeframes.join(',');
  const envDefaultEntry =
    (arch.env.defaultEntry && process.env[arch.env.defaultEntry]) || arch.defaultEntryTimeframe;
  const envHtf = (arch.env.htf && process.env[arch.env.htf]) || arch.defaultHtfTimeframe;
  const envRefine =
    (arch.env.refineHtf && process.env[arch.env.refineHtf]) || arch.defaultRefineHtfTimeframe;

  const entryTimeframes = parseAllowedTimeframes(
    overrides.entryTimeframes !== undefined ? overrides.entryTimeframes : envEntry,
    arch.entryTimeframes,
    [...arch.entryTimeframes]
  );

  let defaultEntryTimeframe = String(
    overrides.defaultEntryTimeframe !== undefined ? overrides.defaultEntryTimeframe : envDefaultEntry
  ).trim();
  if (!entryTimeframes.includes(defaultEntryTimeframe)) {
    defaultEntryTimeframe = entryTimeframes[0] || arch.defaultEntryTimeframe;
  }

  let htfTimeframe = String(
    overrides.htfTimeframe !== undefined ? overrides.htfTimeframe : envHtf
  ).trim();
  if (!arch.htfTimeframes.includes(htfTimeframe)) {
    htfTimeframe = arch.defaultHtfTimeframe;
  }

  let refineHtfTimeframe = null;
  if (arch.refineHtfTimeframes.length) {
    refineHtfTimeframe = String(
      overrides.refineHtfTimeframe !== undefined ? overrides.refineHtfTimeframe : envRefine || ''
    ).trim();
    if (!arch.refineHtfTimeframes.includes(refineHtfTimeframe)) {
      refineHtfTimeframe = arch.defaultRefineHtfTimeframe;
    }
  }

  return {
    key: arch.key,
    id: arch.id,
    name: arch.name,
    entryTimeframes,
    defaultEntryTimeframe,
    htfTimeframe,
    htfTimeframes: [...arch.htfTimeframes],
    refineHtfTimeframe,
    refineHtfTimeframes: [...arch.refineHtfTimeframes],
    useRefineHtf:
      overrides.useRefineHtf !== undefined
        ? Boolean(overrides.useRefineHtf)
        : arch.useRefineHtfDefault
  };
}

/**
 * Validate a resolved strategy TF layout.
 * @param {object} arch - architecture definition
 * @param {object} resolved - { entryTimeframes, defaultEntryTimeframe, htfTimeframe, htfTimeframes?, refineHtfTimeframe? }
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateStrategyTimeframes(arch, resolved) {
  const errors = [];
  const warnings = [];
  if (!arch) {
    errors.push('Missing strategy architecture definition');
    return { ok: false, errors, warnings };
  }

  const entry = [...(resolved.entryTimeframes || [])];
  const htfList = [...(resolved.htfTimeframes || arch.htfTimeframes || [])];
  const htf = resolved.htfTimeframe;
  const defaultEntry = resolved.defaultEntryTimeframe;

  if (!entry.length) {
    errors.push(`${arch.key}: allowed entry timeframes must not be empty`);
  }
  if (!htf) {
    errors.push(`${arch.key}: HTF timeframe is required`);
  }

  const seenEntry = new Set();
  for (const tf of entry) {
    if (seenEntry.has(tf)) errors.push(`${arch.key}: duplicate entry timeframe "${tf}"`);
    seenEntry.add(tf);
    if (tfToMinutes(tf) == null) errors.push(`${arch.key}: unknown entry timeframe "${tf}"`);
    if (!arch.entryTimeframes.includes(tf)) {
      errors.push(
        `${arch.key}: entry timeframe "${tf}" is not in architecture allowlist [${arch.entryTimeframes.join(', ')}]`
      );
    }
    // Hard rule: 1m is never a supported scalping (or any live) entry TF
    if (tf === '1m') {
      errors.push(`${arch.key}: entry timeframe "1m" is not supported`);
    }
  }

  for (const tf of htfList) {
    if (tfToMinutes(tf) == null) errors.push(`${arch.key}: unknown HTF timeframe "${tf}"`);
  }

  if (htf && tfToMinutes(htf) == null) {
    errors.push(`${arch.key}: unknown HTF timeframe "${htf}"`);
  } else if (htf && !arch.htfTimeframes.includes(htf)) {
    errors.push(
      `${arch.key}: HTF "${htf}" is not in architecture allowlist [${arch.htfTimeframes.join(', ')}]`
    );
  }

  if (defaultEntry && !entry.includes(defaultEntry)) {
    errors.push(
      `${arch.key}: default entry TF "${defaultEntry}" is not in allowed entry timeframes`
    );
  }

  // Every entry TF must be strictly lower than the selected HTF
  const htfMin = tfToMinutes(htf);
  if (htfMin != null) {
    for (const tf of entry) {
      const em = tfToMinutes(tf);
      if (em != null && em >= htfMin) {
        errors.push(
          `${arch.key}: entry TF "${tf}" must be lower than HTF "${htf}" (${em}m >= ${htfMin}m)`
        );
      }
    }
  }

  // Entry and HTF sets must not overlap
  for (const tf of entry) {
    if (htfList.includes(tf) || tf === htf) {
      errors.push(`${arch.key}: timeframe "${tf}" cannot be both entry and HTF`);
    }
  }

  if (resolved.refineHtfTimeframe) {
    const refine = resolved.refineHtfTimeframe;
    if (tfToMinutes(refine) == null) {
      errors.push(`${arch.key}: unknown refine HTF "${refine}"`);
    } else if (
      arch.refineHtfTimeframes.length &&
      !arch.refineHtfTimeframes.includes(refine)
    ) {
      errors.push(`${arch.key}: refine HTF "${refine}" not in allowlist`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Validate every registered live strategy architecture (defaults + optional runtime overlays).
 * @param {Object} [runtimeByKey] - optional { scalping: cfg, daytrading: cfg }
 * @returns {{ ok: boolean, errors: string[], warnings: string[], results: Record<string, object> }}
 */
function validateAllStrategyArchitectures(runtimeByKey = {}) {
  const errors = [];
  const warnings = [];
  const results = {};

  for (const key of Object.keys(STRATEGY_ARCHITECTURE)) {
    const arch = STRATEGY_ARCHITECTURE[key];
    const resolved = resolveArchitectureTimeframes(key, runtimeByKey[key] || {});
    const check = validateStrategyTimeframes(arch, {
      ...resolved,
      htfTimeframes: arch.htfTimeframes
    });
    results[key] = { resolved, ...check };
    errors.push(...check.errors);
    warnings.push(...check.warnings);
  }

  return { ok: errors.length === 0, errors, warnings, results };
}

/**
 * Assert valid architectures or throw (used at server startup / Pine generation).
 * @param {Object} [runtimeByKey]
 */
function assertStrategyArchitecturesValid(runtimeByKey = {}) {
  const report = validateAllStrategyArchitectures(runtimeByKey);
  if (!report.ok) {
    const detail = report.errors.join('; ');
    const err = new Error(`Strategy architecture validation failed: ${detail}`);
    err.code = 'strategy_architecture_invalid';
    err.errors = report.errors;
    throw err;
  }
  return report;
}

/**
 * Build Pine template variables for timeframe validation + HTF default injection.
 * @param {StrategyArchKey} key
 * @param {object} [resolvedConfig] - runtime strategy config (htfTimeframe, entryTimeframes, …)
 */
function buildPineTfVariables(key, resolvedConfig = {}) {
  const arch = getStrategyArchitecture(key);
  if (!arch) {
    throw new Error(`Cannot build Pine TF variables for unknown strategy: ${key}`);
  }

  const resolved = resolveArchitectureTimeframes(key, {
    entryTimeframes: resolvedConfig.entryTimeframes,
    defaultEntryTimeframe: resolvedConfig.defaultEntryTimeframe,
    htfTimeframe: resolvedConfig.htfTimeframe,
    refineHtfTimeframe: resolvedConfig.refineHtfTimeframe,
    useRefineHtf: resolvedConfig.useRefineHtf
  });

  const check = validateStrategyTimeframes(arch, {
    ...resolved,
    htfTimeframes: arch.htfTimeframes
  });
  if (!check.ok) {
    const err = new Error(
      `Cannot generate Pine — invalid ${arch.key} TF config: ${check.errors.join('; ')}`
    );
    err.code = 'strategy_architecture_invalid';
    err.errors = check.errors;
    throw err;
  }

  const entryMinutes = resolved.entryTimeframes
    .map(tf => tfToMinutes(tf))
    .filter(n => n != null);
  const htfSeconds = arch.htfTimeframes.map(tf => tfToSeconds(tf)).filter(n => n != null);

  const entryChartOk =
    entryMinutes.length === 0
      ? 'false'
      : `timeframe.isminutes and (${entryMinutes
          .map(m => `timeframe.multiplier == ${m}`)
          .join(' or ')})`;

  const htfTfOk =
    htfSeconds.length === 0 ? 'false' : htfSeconds.map(s => `htfSec == ${s}`).join(' or ');

  const entryLabel = formatTfList(resolved.entryTimeframes);
  const htfLabel = formatTfList(arch.htfTimeframes.map(formatHtfDisplay));
  const htfShort = formatTfList(arch.htfTimeframes);
  const d = arch.diagnostics;

  const diagWrongEntry = `${d.wrongEntry} — attach to ${entryLabel} for entries (HTF is ${htfShort} via request.security)`;
  const diagWrongHtf = `${d.wrongHtf} — set HTF context to ${htfLabel}`;
  const diagChartIsHtf = `${d.chartIsHtf} — switch to ${entryLabel} for entries`;
  const diagUnsupported = `${d.unsupported} — regenerate Pine from KachingFx for ${arch.shortLabel}`;
  const diagMissingHtf = `${d.missingHtf} — select a valid HTF context (${htfLabel})`;

  const htfInputLabel = `HTF context (${htfShort} — never entries)`;
  const htfInputTooltip = `Higher-timeframe confirmation only (${htfLabel}). Fetched via request.security — do not open this chart for entries. Default is baked from Strategy Configuration.`;

  const instructionLead = `Open TradingView → attach this script to a ${entryLabel} chart (entries blocked elsewhere). HTF confirmation uses ${htfShort} via request.security — never open ${htfShort} for entries.`;

  return {
    STRATEGY_KEY: arch.key,
    HTF_TF: tfToPine(resolved.htfTimeframe),
    ENTRY_CHART_OK: entryChartOk,
    HTF_TF_OK: htfTfOk,
    HTF_INPUT_LABEL: htfInputLabel,
    HTF_INPUT_TOOLTIP: htfInputTooltip,
    DIAG_WRONG_ENTRY: diagWrongEntry,
    DIAG_WRONG_HTF: diagWrongHtf,
    DIAG_CHART_IS_HTF: diagChartIsHtf,
    DIAG_UNSUPPORTED: diagUnsupported,
    DIAG_MISSING_HTF: diagMissingHtf,
    ARCH_ENTRY_TIMEFRAMES: [...resolved.entryTimeframes],
    ARCH_HTF_TIMEFRAMES: [...arch.htfTimeframes],
    ARCH_DEFAULT_HTF: resolved.htfTimeframe,
    ARCH_DEFAULT_ENTRY: resolved.defaultEntryTimeframe,
    instructionLead,
    architecture: arch,
    resolved
  };
}

/**
 * Frontend / admin summary (no secrets).
 */
function getArchitecturePublicSummary() {
  const out = {};
  for (const key of Object.keys(STRATEGY_ARCHITECTURE)) {
    const a = STRATEGY_ARCHITECTURE[key];
    out[key] = {
      key: a.key,
      id: a.id,
      name: a.name,
      shortLabel: a.shortLabel,
      entryTimeframes: [...a.entryTimeframes],
      defaultEntryTimeframe: a.defaultEntryTimeframe,
      htfTimeframes: [...a.htfTimeframes],
      defaultHtfTimeframe: a.defaultHtfTimeframe,
      refineHtfTimeframes: [...a.refineHtfTimeframes],
      defaultRefineHtfTimeframe: a.defaultRefineHtfTimeframe
    };
  }
  return out;
}

module.exports = {
  TF_MINUTES,
  STRATEGY_ARCHITECTURE,
  FUTURE_STRATEGY_KEYS,
  tfToMinutes,
  tfToPine,
  tfToSeconds,
  isHtfChartTimeframe,
  formatTfList,
  formatHtfDisplay,
  getStrategyArchitecture,
  parseAllowedTimeframes,
  resolveArchitectureTimeframes,
  validateStrategyTimeframes,
  validateAllStrategyArchitectures,
  assertStrategyArchitecturesValid,
  buildPineTfVariables,
  getArchitecturePublicSummary
};
