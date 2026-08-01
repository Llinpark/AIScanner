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
  generateLicenseToken,
  normalizeTradingViewUsername
} = require('../utils/webhookSecurity');
const { getTierDisplayName, getEffectiveSubscription } = require('../utils/subscriptionAccess');

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
      message: sampleHumanAlertMessage('long', 2650.5, 2648.2, 2655.1, 2657.4, 2659.7),
      licenseToken: '<your-license-token>',
      tradingviewUsername: '<your-tradingview-username>',
      broadcast: true
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
    broadcast: true
  };
}

function buildSweepVariables(base, config, title, shortTitle, htfPine) {
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
    TP1_R: rr[0] ?? 1.5,
    TP2_R: rr[1] ?? 2,
    TP3_R: rr[2] ?? 3,
    ENABLE_DYNAMIC_TP: enableSmart ? 'true' : 'false',
    TP1_ATR_CAP: atrCaps[0] ?? 0.7,
    TP2_ATR_CAP: atrCaps[1] ?? 1.3,
    TP3_ATR_CAP: atrCaps[2] ?? 2.0,
    CONFIDENCE_THRESHOLD: config.confidence?.threshold ?? 70,
    REQUIRE_ENGULFING: config.engulfing?.required ? 'true' : 'false'
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
    SUBSCRIBER_ID: escapePineString(userId)
  };

  let variables;
  let templatePath;
  let strategyLabel;
  let instructionLead;

  if (strategyKey === 'scalping') {
    const {
      getResolvedScalpingConfig
    } = require('../utils/strategyRuntimeConfig');
    const scalp = getResolvedScalpingConfig();
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
  } else {
    const {
      getResolvedDaytradingConfig
    } = require('../utils/strategyRuntimeConfig');
    const day = getResolvedDaytradingConfig();
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
  }

  const script = renderTemplate(loadTemplate(templatePath), {
    ...variables,
    DRAWING_ENGINE: loadDrawingEngine()
  });

  return {
    script,
    scriptId,
    webhookUrl,
    licenseToken,
    tradingviewUsername: tvUsername,
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
      'Supported symbols ONLY: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, XAUUSD, US30, US100. Attach the script to those charts only — Deriv / Jump / Volatility / other symbols are blocked and will not alert.',
      `Confirm username is prefilled to ${tvUsername} under KachingFx License — leave it as-is to unlock. Override only if needed; signals stay locked until Confirm matches the licensed username.`,
      'When a signal fires, TradingView shows separate labels: Kaching Buy/Sell badge, plus Buy/Sell, SL, TP1, TP2, TP3 (each one object). Badge text never mixes with TP text.',
      'Overlays stay until TP3, SL, candle expiry, or cancel — they do not disappear if a later setup fails. Lines extend to the live candle every bar while the trade is active.',
      'Adjust “Initial trade level length” and “Active trade expiry (candles)” under KachingFx Display (scalp default expiry 60, day trading 80; disable with Enable trade candle expiry).',
      `Create one alert for this script, enable webhook notifications, and paste: ${webhookUrl}`,
      'Your script is bound to your TradingView username and private license token — do not share it. Pasting it into another TradingView account will not produce valid alerts.',
      'After regenerating Pine, remove the old indicator from the chart, paste the new script, and recreate the alert so drawings and symbol gates take effect.',
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
  sampleWebhookPayload,
  resolveStrategyKey,
  resolveTradingViewUsername
};
