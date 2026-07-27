const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WEBHOOK_TRADINGVIEW_URL } = require('../config/appUrls');
const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const {
  resolveScalpingConfig,
  STRATEGY_NAME: SCALPING_STRATEGY_NAME
} = require('../strategies/config/scalpingConfig');
const {
  resolveDayTradingConfig,
  STRATEGY_NAME: DAYTRADING_SWEEP_NAME
} = require('../strategies/config/dayTradingConfig');
const { generateLicenseToken } = require('../utils/webhookSecurity');
const { getTierDisplayName, getEffectiveSubscription } = require('../utils/subscriptionAccess');

const CLASSIC_TEMPLATE = path.join(__dirname, '..', 'templates', 'kaching-scanner.pine.template');
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

const templateCache = new Map();

function loadTemplate(templatePath) {
  if (templateCache.has(templatePath)) return templateCache.get(templatePath);
  const src = fs.readFileSync(templatePath, 'utf8');
  templateCache.set(templatePath, src);
  return src;
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
 * @returns {'classic'|'daytrading'|'scalping'}
 */
function resolveStrategyKey(strategy) {
  const key = String(strategy || process.env.PINE_DEFAULT_STRATEGY || 'daytrading').toLowerCase();
  if (
    key === 'scalping' ||
    key === 'scalp' ||
    key === 'liquidity_sweep_fvg_scalp' ||
    key === 'sweep_fvg_scalp'
  ) {
    return 'scalping';
  }
  if (
    key === 'classic' ||
    key === 'breakaway' ||
    key === 'fvg_breakaway' ||
    key === 'kachingfx_pine'
  ) {
    return 'classic';
  }
  // daytrading | liquidity_sweep_fvg_daytrading | sweep_fvg
  return 'daytrading';
}

function sampleWebhookPayload(strategyKey = 'daytrading') {
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
      message: 'Kaching Entry',
      licenseToken: '<your-license-token>',
      broadcast: true
    };
  }

  if (strategyKey === 'daytrading') {
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
      message: 'Kaching Entry',
      licenseToken: '<your-license-token>',
      broadcast: true
    };
  }

  return {
    symbol: 'XAUUSD',
    strategyName: 'KachingFx Pine',
    timeframe: '60',
    pattern: 'perfect_fvg',
    alertType: 'entry',
    direction: 'long',
    entry: 2650.5,
    stop_loss: 2645.5,
    stop_loss_1: 2645.5,
    take_profit_1: 2655.5,
    take_profit_2: 2660.5,
    take_profit_3: 2665.5,
    confidence: 0.82,
    message: 'Kaching Entry',
    licenseToken: '<your-license-token>',
    broadcast: true
  };
}

function buildClassicVariables(base, risk) {
  return {
    ...base,
    INDICATOR_TITLE: escapePineString('KachingFx Scanner'),
    INDICATOR_SHORTTITLE: escapePineString('KachingFx Scanner'),
    MIN_BODY_RATIO: PATTERN_SCANNER_CONFIG.fvg?.minDisplacementBodyRatio ?? 0.62,
    MAX_WICK_RATIO: PATTERN_SCANNER_CONFIG.fvg?.maxWickToRangeRatio ?? 0.28,
    VOL_MULT: PATTERN_SCANNER_CONFIG.fvg?.volumeMultiplier ?? 1.15,
    C1_DISP_BODY: PATTERN_SCANNER_CONFIG.breakaway?.minC1BodyRatio ?? 0.55,
    MIN_GAP_RATIO: PATTERN_SCANNER_CONFIG.breakaway?.minGapToC1RangeRatio ?? 0.08,
    SL_PIPS: risk.slPips ?? 30,
    TP1_R: risk.tpRatios?.[0] ?? 1.0,
    TP2_R: risk.tpRatios?.[1] ?? 2.0,
    TP3_R: risk.tpRatios?.[2] ?? 3.0
  };
}

function buildSweepVariables(base, config, title, shortTitle, htfPine) {
  const rr = config.takeProfit?.rrMultiples || [2, 3, 4];
  return {
    ...base,
    INDICATOR_TITLE: escapePineString(title),
    INDICATOR_SHORTTITLE: escapePineString(shortTitle),
    HTF_TF: escapePineString(htfPine),
    SWING_SENSITIVITY: config.swing?.sensitivity ?? 2,
    EQH_EQL_TOLERANCE: config.swing?.equalToleranceAtrRatio ?? 0.08,
    MIN_BODY_RATIO: config.displacement?.minBodyRatio ?? 0.62,
    MAX_WICK_RATIO: config.displacement?.maxWickRatio ?? 0.32,
    DISP_ATR_MULT: config.displacement?.minRangeToAtrRatio ?? 1.05,
    MIN_FVG_ATR: config.fvg?.minGapToAtrRatio ?? 0.12,
    ENTRY_MODEL: escapePineString(config.entry?.model || 'ce'),
    STOP_MODEL: escapePineString(config.stop?.model || 'sweep'),
    TP1_R: rr[0] ?? 2,
    TP2_R: rr[1] ?? 3,
    TP3_R: rr[2] ?? 4,
    CONFIDENCE_THRESHOLD: config.confidence?.threshold ?? 70,
    REQUIRE_ENGULFING: config.engulfing?.required ? 'true' : 'false'
  };
}

function generateForUser(user, options = {}) {
  const userId = user._id?.toString() || user.id || '';
  const subscription = getEffectiveSubscription(user);
  const tier = subscription.tier || 'basic';
  const risk = PATTERN_SCANNER_CONFIG.risk || {};
  const webhookUrl = options.webhookUrl || WEBHOOK_TRADINGVIEW_URL;
  const webhookSecret = options.webhookSecret || process.env.TRADINGVIEW_WEBHOOK_SECRET || '';
  const strategyKey = resolveStrategyKey(options.strategy || options.strategyId);

  const tvUsername =
    user.tradingviewUsername ||
    user.preferences?.tradingviewUsername ||
    user.displayName ||
    '';

  const scriptId = buildScriptId(userId);
  const tierLabel = getTierDisplayName(tier);
  const subscriberLabel = user.email || user.displayName || userId || 'subscriber';
  const licenseToken = userId ? generateLicenseToken(userId) : '';

  const base = {
    SUBSCRIBER_LABEL: escapePineString(subscriberLabel),
    SUBSCRIPTION_TIER: escapePineString(tierLabel),
    SCRIPT_ID: escapePineString(scriptId),
    WEBHOOK_URL: escapePineString(webhookUrl),
    WEBHOOK_SECRET: escapePineString(webhookSecret),
    LICENSE_TOKEN: escapePineString(licenseToken),
    TV_USERNAME: escapePineString(tvUsername),
    SUBSCRIBER_ID: escapePineString(userId)
  };

  let variables;
  let templatePath;
  let strategyLabel;
  let instructionLead;

  if (strategyKey === 'scalping') {
    const scalp = resolveScalpingConfig();
    variables = buildSweepVariables(
      base,
      scalp,
      'KachingFx Sweep+FVG Scalp',
      'Kaching Scalp',
      scalp.htfTimeframe === '15m' ? '15' : String(scalp.htfTimeframe).replace('m', '')
    );
    templatePath = SCALPING_TEMPLATE;
    strategyLabel = SCALPING_STRATEGY_NAME;
    instructionLead =
      'Open TradingView → attach this script to a 1m or 3m chart (entries blocked elsewhere). HTF liquidity uses 15m context only.';
  } else if (strategyKey === 'daytrading') {
    const day = resolveDayTradingConfig();
    variables = buildSweepVariables(
      base,
      day,
      'KachingFx Sweep+FVG Day',
      'Kaching Day',
      day.htfTimeframe === '4h' ? '240' : String(day.htfTimeframe)
    );
    templatePath = DAYTRADING_SWEEP_TEMPLATE;
    strategyLabel = DAYTRADING_SWEEP_NAME;
    instructionLead =
      'Open TradingView → attach this script to a 15m or 5m chart (entries blocked on HTF). HTF bias/liquidity uses 4H context.';
  } else {
    variables = buildClassicVariables(base, risk);
    templatePath = CLASSIC_TEMPLATE;
    strategyLabel = 'KachingFx Classic (FVG / Breakaway)';
    instructionLead =
      'Open TradingView → Pine Editor → paste your personal script → Add to any chart (forex, gold, indices, crypto, stocks, etc.).';
  }

  const script = renderTemplate(loadTemplate(templatePath), variables);

  return {
    script,
    scriptId,
    webhookUrl,
    licenseToken,
    tier,
    tierLabel,
    subscriberLabel,
    strategy: strategyKey,
    strategyName: strategyLabel,
    generatedAt: new Date().toISOString(),
    architecture: 'tradingview_webhook_distribution',
    flow: 'TradingView → webhook → Kaching dashboard / Telegram / MT5',
    samplePayload: sampleWebhookPayload(strategyKey),
    availableStrategies: [
      { id: 'daytrading', name: DAYTRADING_SWEEP_NAME, default: strategyKey === 'daytrading' },
      { id: 'scalping', name: SCALPING_STRATEGY_NAME, default: strategyKey === 'scalping' },
      {
        id: 'classic',
        name: 'KachingFx Classic (FVG / Breakaway)',
        default: strategyKey === 'classic'
      }
    ],
    security: {
      licenseTokenIncluded: Boolean(licenseToken),
      authNote: 'Your script already includes a private license token. Do not share the generated script.'
    },
    instructions: [
      instructionLead,
      'When a signal fires, TradingView shows only Kaching Entry, Kaching SL, Kaching TP1, Kaching TP2, and Kaching TP3 — no liquidity/FVG/confidence labels on the chart.',
      `Create one alert for this script, enable webhook notifications, and paste: ${webhookUrl}`,
      'Your script already includes a private license token — do not share it with anyone.',
      'Switch strategies with ?strategy=daytrading | scalping | classic.',
      'Re-copy and re-add this script after plan or script updates so TradingView uses the latest overlay logic.',
      `This script was generated for ${subscriberLabel} (${tierLabel} plan).`
    ]
  };
}

module.exports = {
  generateForUser,
  escapePineString,
  buildScriptId,
  sampleWebhookPayload,
  resolveStrategyKey
};
