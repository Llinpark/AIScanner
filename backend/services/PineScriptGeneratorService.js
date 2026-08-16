const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WEBHOOK_TRADINGVIEW_URL } = require('../config/appUrls');
const {
  STRATEGY_NAME: SCALPING_STRATEGY_NAME
} = require('../strategies/config/scalpingConfig');
const {
  STRATEGY_NAME: DAYTRADING_SWEEP_NAME
} = require('../strategies/config/dayTradingConfig');
const {
  buildPineTfVariables,
  formatTfList,
  assertStrategyArchitecturesValid,
  getStrategyArchitecture
} = require('../strategies/config/strategyArchitecture');
const {
  generateLicenseToken,
  normalizeTradingViewUsername
} = require('../utils/webhookSecurity');
const { getTierDisplayName, getEffectiveSubscription } = require('../utils/subscriptionAccess');
const {
  PINE_CLIENT_VERSION,
  CURRENT_PINE_CAPABILITIES,
  capabilitiesJsonLiteral
} = require('../utils/PineClientVersion');

const SCALPING_TEMPLATE = path.join(
  __dirname,
  '..',
  'templates',
  'kaching-sweep-fvg-scalp.pine.template'
);
const DAYTRADING_SWEEP_TEMPLATE = path.join(
  __dirname,
  '..',
  'templates',
  'kaching-sweep-fvg-daytrading.pine.template'
);
const DRAWING_ENGINE_SNIPPET = path.join(
  __dirname,
  '..',
  'templates',
  'snippets',
  'kaching-trade-drawing.pine.snippet'
);
const EVENT_BRIDGE_SNIPPET = path.join(
  __dirname,
  '..',
  'templates',
  'snippets',
  'kaching-canon-event-bridge.pine.snippet'
);
const EVENT_ARM_SNIPPET = path.join(
  __dirname,
  '..',
  'templates',
  'snippets',
  'kaching-canon-event-arm.pine.snippet'
);
const DRAWING_RUNTIME_SNIPPET = path.join(
  __dirname,
  '..',
  'templates',
  'snippets',
  'kaching-trade-drawing-runtime.pine.snippet'
);

const templateCache = new Map();

function loadTemplate(templatePath) {
  if (templateCache.has(templatePath)) return templateCache.get(templatePath);
  const src = fs.readFileSync(templatePath, 'utf8');
  templateCache.set(templatePath, src);
  return src;
}

function loadDrawingEngine() {
  return loadTemplate(DRAWING_ENGINE_SNIPPET);
}

function loadEventBridge() {
  return loadTemplate(EVENT_BRIDGE_SNIPPET);
}

function loadEventArm() {
  return loadTemplate(EVENT_ARM_SNIPPET);
}

function loadDrawingRuntime() {
  return loadTemplate(DRAWING_RUNTIME_SNIPPET);
}

function escapePineString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function buildScriptId(userId) {
  const hash = crypto.createHash('sha256').update(String(userId || 'anonymous')).digest('hex');
  return hash.slice(0, 12);
}

/** Unique id per generateForUser call (not the stable scriptId). */
function buildScriptGenerationId(userId, scriptId) {
  const stamp = `${userId || 'anon'}|${scriptId || ''}|${Date.now()}|${crypto.randomBytes(8).toString('hex')}`;
  return crypto.createHash('sha256').update(stamp).digest('hex').slice(0, 16);
}

function renderTemplate(template, variables) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => {
    if (!(key in variables)) {
      throw new Error(`Missing Pine template variable: ${key}`);
    }
    return String(variables[key]);
  });
}

/**
 * @param {string} [strategy]
 * @returns {'daytrading'|'scalping'}
 */
function resolveStrategyKey(strategy) {
  const key = String(strategy || process.env.PINE_DEFAULT_STRATEGY || 'scalping').toLowerCase();
  if (
    key === 'scalping' ||
    key === 'scalp' ||
    key === 'liquidity_sweep_fvg_scalp' ||
    key === 'sweep_fvg_scalp'
  ) {
    return 'scalping';
  }
  // daytrading | liquidity_sweep_fvg_daytrading | sweep_fvg | unknown aliases → daytrading
  return 'daytrading';
}

function resolveTradingViewUsername(user) {
  return normalizeTradingViewUsername(
    user?.tradingviewUsername || user?.preferences?.tradingviewUsername || ''
  );
}

function sampleHumanAlertMessage(direction, entry, sl, tp1, tp2, tp3) {
  const header = direction === 'short' ? '🟥 Kaching SELL' : '🟦 Kaching BUY';
  return `${header}\nEntry: ${entry}\nSL: ${sl}\nTP1: ${tp1}\nTP2: ${tp2}\nTP3: ${tp3}`;
}

function sampleWebhookPayload(strategyKey = 'daytrading', versionMeta = null) {
  const additive =
    versionMeta && typeof versionMeta === 'object'
      ? {
          pineClientVersion: versionMeta.pineClientVersion || PINE_CLIENT_VERSION,
          generatedAt: versionMeta.generatedAt || undefined,
          scriptGenerationId: versionMeta.scriptGenerationId || undefined,
          capabilities: Array.isArray(versionMeta.capabilities)
            ? versionMeta.capabilities
            : [...CURRENT_PINE_CAPABILITIES]
        }
      : {
          pineClientVersion: PINE_CLIENT_VERSION,
          capabilities: [...CURRENT_PINE_CAPABILITIES]
        };

  if (strategyKey === 'scalping') {
    return {
      symbol: 'XAUUSD',
      strategyName: SCALPING_STRATEGY_NAME,
      timeframe: '3',
      pattern: 'liquidity_sweep_fvg_scalp',
      alertType: 'entry',
      direction: 'long',
      entry: 2650.5,
      stop_loss: 2648.2,
      stop_loss_1: 2648.2,
      take_profit_1: 2655.1,
      take_profit_2: 2657.4,
      take_profit_3: 2659.7,
      confidence: 0.85,
      message: sampleHumanAlertMessage('long', 2650.5, 2648.2, 2655.1, 2657.4, 2659.7),
      licenseToken: '<your-license-token>',
      tradingviewUsername: '<your-tradingview-username>',
      broadcast: true,
      ...additive
    };
  }

  return {
    symbol: 'XAUUSD',
    strategyName: DAYTRADING_SWEEP_NAME,
    timeframe: '15',
    pattern: 'liquidity_sweep_fvg_daytrading',
    alertType: 'entry',
    direction: 'long',
    entry: 2650.5,
    stop_loss: 2644.0,
    stop_loss_1: 2644.0,
    take_profit_1: 2663.5,
    take_profit_2: 2670.0,
    take_profit_3: 2680.0,
    confidence: 0.82,
    message: sampleHumanAlertMessage('long', 2650.5, 2644.0, 2663.5, 2670.0, 2680.0),
    licenseToken: '<your-license-token>',
    tradingviewUsername: '<your-tradingview-username>',
    broadcast: true,
    ...additive
  };
}

/**
 * Merge strategy thresholds + config-driven TF validation into Pine template vars.
 * HTF / entry TF validation is NEVER hardcoded here — always from Strategy Configuration.
 */
function buildSweepVariables(base, config, title, shortTitle, strategyKey) {
  const rr = config.takeProfit?.rrMultiples || [1.5, 2, 3];
  const atrCaps = config.takeProfit?.atrCaps || [0.7, 1.3, 2.0];
  const model = String(config.takeProfit?.model || 'smart_scoring').toLowerCase();
  const enableSmart =
    (config.takeProfit?.enableSmartTpScoring !== false &&
      config.takeProfit?.enableDynamicTp !== false) &&
    (model === 'smart_scoring' ||
      model === 'smart_tp' ||
      model === 'dynamic_liquidity' ||
      model === 'dynamic');
  const pineTf = buildPineTfVariables(strategyKey, config);
  return {
    ...base,
    INDICATOR_TITLE: escapePineString(title),
    INDICATOR_SHORTTITLE: escapePineString(shortTitle),
    HTF_TF: escapePineString(pineTf.HTF_TF),
    CANONICAL_SIGNAL_TF: escapePineString(pineTf.CANONICAL_SIGNAL_TF),
    ARCH_CANONICAL_SIGNAL_TF: escapePineString(pineTf.ARCH_CANONICAL_SIGNAL_TF),
    STRATEGY_KEY: escapePineString(pineTf.STRATEGY_KEY),
    ENTRY_CHART_OK: pineTf.ENTRY_CHART_OK,
    HTF_TF_OK: pineTf.HTF_TF_OK,
    TRADING_STYLE_EXPR: pineTf.TRADING_STYLE_EXPR,
    HTF_INPUT_LABEL: escapePineString(pineTf.HTF_INPUT_LABEL),
    HTF_INPUT_TOOLTIP: escapePineString(pineTf.HTF_INPUT_TOOLTIP),
    DIAG_WRONG_ENTRY: escapePineString(pineTf.DIAG_WRONG_ENTRY),
    DIAG_WRONG_HTF: escapePineString(pineTf.DIAG_WRONG_HTF),
    DIAG_CHART_IS_HTF: escapePineString(pineTf.DIAG_CHART_IS_HTF),
    DIAG_UNSUPPORTED: escapePineString(pineTf.DIAG_UNSUPPORTED),
    DIAG_MISSING_HTF: escapePineString(pineTf.DIAG_MISSING_HTF),
    ARCH_ENTRY_LABEL: escapePineString(formatTfList(pineTf.ARCH_ENTRY_TIMEFRAMES)),
    ARCH_HTF_LABEL: escapePineString(formatTfList(pineTf.ARCH_HTF_TIMEFRAMES)),
    SWING_SENSITIVITY: config.swing?.sensitivity ?? 2,
    EQH_EQL_TOLERANCE: config.swing?.equalToleranceAtrRatio ?? 0.08,
    MIN_BODY_RATIO: config.displacement?.minBodyRatio ?? 0.62,
    MAX_WICK_RATIO: config.displacement?.maxWickRatio ?? 0.32,
    DISP_ATR_MULT: config.displacement?.minRangeToAtrRatio ?? 1.05,
    MIN_FVG_ATR: config.fvg?.minGapToAtrRatio ?? 0.12,
    ENTRY_MODEL: escapePineString(config.entry?.model || 'ce'),
    STOP_MODEL: escapePineString(config.stop?.model || 'sweep'),
    SL_BUFFER_ATR: config.stop?.bufferAtrRatio ?? 0.05,
    // Entry-TF ATR multiplier that actually caps structural SL distance (not TP caps).
    MAX_STOP_ATR_MULT: config.stop?.maxStopAtrMult ?? 1.5,
    MIN_RR: config.takeProfit?.minRr ?? rr[0] ?? 1.5,
    TP1_R: rr[0] ?? 1.5,
    TP2_R: rr[1] ?? 2,
    TP3_R: rr[2] ?? 3,
    ENABLE_DYNAMIC_TP: enableSmart ? 'true' : 'false',
    TP1_ATR_CAP: atrCaps[0] ?? 0.7,
    TP2_ATR_CAP: atrCaps[1] ?? 1.3,
    TP3_ATR_CAP: atrCaps[2] ?? 2.0,
    CONFIDENCE_THRESHOLD: config.confidence?.threshold ?? 70,
    REQUIRE_ENGULFING: config.engulfing?.required ? 'true' : 'false',
    _pineTf: pineTf
  };
}

function generateForUser(user, options = {}) {
  const userId = user._id?.toString() || user.id || '';
  const subscription = getEffectiveSubscription(user);
  const tier = subscription.tier || 'basic';
  const webhookUrl = options.webhookUrl || WEBHOOK_TRADINGVIEW_URL;
  const strategyKey = resolveStrategyKey(options.strategy || options.strategyId);

  const tvUsername = resolveTradingViewUsername(user);
  if (!tvUsername) {
    const err = new Error(
      'Link your TradingView username before generating your personal script.'
    );
    err.code = 'tradingview_username_required';
    throw err;
  }

  const scriptId = buildScriptId(userId);
  const scriptGenerationId = buildScriptGenerationId(userId, scriptId);
  const generatedAt = new Date().toISOString();
  const pineClientVersion = PINE_CLIENT_VERSION;
  const pineCapabilities = [...CURRENT_PINE_CAPABILITIES];
  const tierLabel = getTierDisplayName(tier);
  const subscriberLabel = user.email || user.displayName || userId || 'subscriber';
  const licenseToken = userId ? generateLicenseToken(userId, tvUsername) : '';

  const base = {
    SUBSCRIBER_LABEL: escapePineString(subscriberLabel),
    SUBSCRIPTION_TIER: escapePineString(tierLabel),
    SCRIPT_ID: escapePineString(scriptId),
    WEBHOOK_URL: escapePineString(webhookUrl),
    // WEBHOOK_SECRET intentionally omitted — auth is licenseToken only (no master secret in Pine).
    WEBHOOK_SECRET: '',
    LICENSE_TOKEN: escapePineString(licenseToken),
    TV_USERNAME: escapePineString(tvUsername),
    SUBSCRIBER_ID: escapePineString(userId),
    // Additive Pine client version metadata (new regenerations only).
    PINE_CLIENT_VERSION: escapePineString(pineClientVersion),
    SCRIPT_GENERATION_ID: escapePineString(scriptGenerationId),
    PINE_GENERATED_AT: escapePineString(generatedAt),
    PINE_CAPABILITIES_JSON: capabilitiesJsonLiteral(pineCapabilities)
  };

  // Fail before generation if Strategy Configuration is inconsistent.
  assertStrategyArchitecturesValid();

  let variables;
  let templatePath;
  let strategyLabel;
  let instructionLead;
  let pineTfMeta;

  if (strategyKey === 'scalping') {
    const {
      getResolvedScalpingConfig
    } = require('../utils/strategyRuntimeConfig');
    const scalp = getResolvedScalpingConfig();
    const arch = getStrategyArchitecture('scalping');
    variables = buildSweepVariables(
      base,
      scalp,
      arch.pineTitle,
      arch.pineShortTitle,
      'scalping'
    );
    templatePath = SCALPING_TEMPLATE;
    strategyLabel = SCALPING_STRATEGY_NAME;
    pineTfMeta = variables._pineTf;
    instructionLead = pineTfMeta.instructionLead;
  } else {
    const {
      getResolvedDaytradingConfig
    } = require('../utils/strategyRuntimeConfig');
    const day = getResolvedDaytradingConfig();
    const arch = getStrategyArchitecture('daytrading');
    variables = buildSweepVariables(
      base,
      day,
      arch.pineTitle,
      arch.pineShortTitle,
      'daytrading'
    );
    templatePath = DAYTRADING_SWEEP_TEMPLATE;
    strategyLabel = DAYTRADING_SWEEP_NAME;
    pineTfMeta = variables._pineTf;
    instructionLead = pineTfMeta.instructionLead;
  }

  const { _pineTf, ...templateVars } = variables;
  // Snippets may contain {{ARCH_*}} (and similar) tokens. Pre-render them so a
  // single-pass main-template replace cannot leave unresolved placeholders
  // (or, historically, inject snippet bodies into comments that mentioned
  // {{EVENT_BRIDGE}} by name).
  const EVENT_BRIDGE = renderTemplate(loadEventBridge(), templateVars);
  const DRAWING_ENGINE = renderTemplate(loadDrawingEngine(), templateVars);
  const EVENT_ARM = renderTemplate(loadEventArm(), templateVars);
  const DRAWING_RUNTIME = renderTemplate(loadDrawingRuntime(), templateVars);
  const script = renderTemplate(loadTemplate(templatePath), {
    ...templateVars,
    EVENT_BRIDGE,
    DRAWING_ENGINE,
    EVENT_ARM,
    DRAWING_RUNTIME
  });

  const versionMeta = {
    pineClientVersion,
    scriptGenerationId,
    generatedAt,
    capabilities: pineCapabilities
  };

  return {
    script,
    scriptId,
    scriptGenerationId,
    pineClientVersion,
    capabilities: pineCapabilities,
    webhookUrl,
    licenseToken,
    tradingviewUsername: tvUsername,
    tier,
    tierLabel,
    subscriberLabel,
    strategy: strategyKey,
    strategyName: strategyLabel,
    generatedAt,
    architecture: 'tradingview_webhook_distribution',
    strategyArchitecture: {
      entryTimeframes: pineTfMeta.ARCH_ENTRY_TIMEFRAMES,
      htfTimeframes: pineTfMeta.ARCH_HTF_TIMEFRAMES,
      canonicalSignalTimeframe: pineTfMeta.ARCH_CANONICAL_SIGNAL_TF,
      defaultHtfTimeframe: pineTfMeta.ARCH_DEFAULT_HTF,
      defaultEntryTimeframe: pineTfMeta.ARCH_DEFAULT_ENTRY,
      bakedHtfPine: pineTfMeta.HTF_TF,
      bakedCanonicalSignalPine: pineTfMeta.CANONICAL_SIGNAL_TF
    },
    flow: 'TradingView → webhook → Kaching dashboard / Telegram / MT5',
    samplePayload: sampleWebhookPayload(strategyKey, versionMeta),
    availableStrategies: [
      { id: 'daytrading', name: DAYTRADING_SWEEP_NAME, default: strategyKey === 'daytrading' },
      { id: 'scalping', name: SCALPING_STRATEGY_NAME, default: strategyKey === 'scalping' }
    ],
    security: {
      licenseTokenIncluded: Boolean(licenseToken),
      tradingviewUsernameBound: true,
      tradingviewUsername: tvUsername,
      authNote:
        'This script is licensed to your TradingView username and includes a private license token. Confirm is prefilled to that username so the script unlocks after paste. It will not send valid alerts from another TradingView account. Do not share the generated script.'
    },
    instructions: [
      instructionLead,
      '1) Paste the generated Pine into TradingView\'s Pine Editor, then Save.',
      '2) Add this indicator to your chart (Kaching scripts are indicator() — not strategy()). TradingView OHLC on that chart is the source of truth (any instrument).',
      `Confirm username is prefilled to ${tvUsername} under KachingFx License — leave it as-is to unlock. Override only if needed; signals stay locked until Confirm matches the licensed username.`,
      'When a signal fires, TradingView shows separate labels: Kaching Buy/Sell badge, plus Buy/Sell, SL, TP1, TP2, TP3 (each one object). Badge text never mixes with TP text.',
      'Overlays stay until TP3, SL, candle expiry, or cancel — they do not disappear if a later setup fails. Lines extend to the live candle every bar while the trade is active.',
      'Adjust “Initial trade level length” and “Active trade expiry (candles)” under KachingFx Display (scalp default expiry 60, day trading 80; disable with Enable trade candle expiry).',
      // ONE alert only — webhook URL from PUBLIC_BACKEND_URL / WEBHOOK_TRADINGVIEW_URL
      `3) Create ONE alert on this chart for this script. Condition: Any alert() function call. Enable Webhook URL and paste exactly: ${webhookUrl}`,
      '4) Message: Leave BLANK. If TradingView requires a placeholder, use ONLY {{alert_message}}. Never {{strategy.order.alert_message}} — that strategy() order placeholder will NOT expand on this indicator() and breaks webhooks.',
      '5) Never type custom JSON into the Message field. Never wrap, edit, or replace the payload from alert().',
      'Alert frequency: Once Per Bar Close (script already uses alert.freq_all on confirmed bars). Expiration: Open-ended / no expire — do not let the alert expire or webhooks stop.',
      'Webhook payload is the full JSON from Pine alert() (symbol, levels, licenseToken, tradingviewUsername, signalUuid). TradingView must deliver that JSON body to the webhook URL.',
      '6) After regenerating Pine: delete the old alert and create a new one (stale Message / strategy placeholders break webhooks).',
      'Optional: enable DEBUG_MODE on the script to see on-chart labels + Pine Logs ([PIPELINE] DEBUG STATE / ALERT NOT FIRED / DRAWING CREATED / ALERT FIRING) for why alert() was skipped (license, wrong entry TF, HTF, confidence, trade active, bar unconfirmed, retrace, FVG). Turn DEBUG_MODE OFF for live trading.',
      'Entry/SL/TP drawings arm with the same confirmed fireLong/fireShort event as alert(). DRAWING CREATED always precedes ALERT FIRING in Pine Logs. TradingView ignores alert() on historical bars.',
      'Your script is bound to your TradingView username and private license token — do not share it. Pasting it into another TradingView account will not produce valid alerts.',
      'REQUIRED after this deploy: regenerate Pine in the app, remove the old indicator from the chart, paste the new script, and recreate the ONE alert so drawings stay synced with webhook alerts.',
      'Switch strategies with ?strategy=daytrading | scalping.',
      'After updating your TradingView username in the app, re-save, re-copy this script, and re-add it to the chart so the license token and prefilled Confirm match.',
      `This script was generated for ${subscriberLabel} (${tierLabel} plan) · TV: ${tvUsername}.`
    ]
  };
}

module.exports = {
  generateForUser,
  escapePineString,
  buildScriptId,
  buildScriptGenerationId,
  sampleWebhookPayload,
  resolveStrategyKey,
  resolveTradingViewUsername,
  buildSweepVariables,
  PINE_CLIENT_VERSION,
  CURRENT_PINE_CAPABILITIES
};
