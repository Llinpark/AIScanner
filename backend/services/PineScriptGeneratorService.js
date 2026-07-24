const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WEBHOOK_TRADINGVIEW_URL } = require('../config/appUrls');
const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const { generateLicenseToken } = require('../utils/webhookSecurity');
const { getTierDisplayName, getEffectiveSubscription } = require('../utils/subscriptionAccess');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'kaching-scanner.pine.template');

let cachedTemplate = null;

function loadTemplate() {
  if (cachedTemplate) return cachedTemplate;
  cachedTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return cachedTemplate;
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

function sampleWebhookPayload() {
  return {
    // Example only — live alerts use whatever chart symbol TradingView sends (any instrument).
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

function generateForUser(user, options = {}) {
  const userId = user._id?.toString() || user.id || '';
  const subscription = getEffectiveSubscription(user);
  const tier = subscription.tier || 'basic';
  const risk = PATTERN_SCANNER_CONFIG.risk || {};
  const webhookUrl = options.webhookUrl || WEBHOOK_TRADINGVIEW_URL;
  const webhookSecret = options.webhookSecret || process.env.TRADINGVIEW_WEBHOOK_SECRET || '';

  const tvUsername =
    user.tradingviewUsername ||
    user.preferences?.tradingviewUsername ||
    user.displayName ||
    '';

  const scriptId = buildScriptId(userId);
  const tierLabel = getTierDisplayName(tier);
  const subscriberLabel = user.email || user.displayName || userId || 'subscriber';
  const licenseToken = userId ? generateLicenseToken(userId) : '';

  const variables = {
    INDICATOR_TITLE: escapePineString('KachingFx Scanner'),
    INDICATOR_SHORTTITLE: escapePineString('KachingFx Scanner'),
    SUBSCRIBER_LABEL: escapePineString(subscriberLabel),
    SUBSCRIPTION_TIER: escapePineString(tierLabel),
    SCRIPT_ID: escapePineString(scriptId),
    WEBHOOK_URL: escapePineString(webhookUrl),
    WEBHOOK_SECRET: escapePineString(webhookSecret),
    LICENSE_TOKEN: escapePineString(licenseToken),
    TV_USERNAME: escapePineString(tvUsername),
    SUBSCRIBER_ID: escapePineString(userId),
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

  const script = renderTemplate(loadTemplate(), variables);

  return {
    script,
    scriptId,
    webhookUrl,
    licenseToken,
    tier,
    tierLabel,
    subscriberLabel,
    generatedAt: new Date().toISOString(),
    architecture: 'tradingview_webhook_distribution',
    flow: 'TradingView → webhook → Kaching dashboard / Telegram / MT5',
    samplePayload: sampleWebhookPayload(),
    security: {
      licenseTokenIncluded: Boolean(licenseToken),
      // User-facing only — do not expose HMAC / signature headers in the dashboard.
      authNote: 'Your script already includes a private license token. Do not share the generated script.'
    },
    instructions: [
      'Open TradingView → Pine Editor → paste your personal script → Add to any chart (forex, gold, indices, crypto, stocks, etc.).',
      `Create one alert for this script, enable webhook notifications, and paste: ${webhookUrl}`,
      'Your script already includes a private license token — do not share it with anyone.',
      'When an alert fires, Kaching publishes that chart’s symbol to your dashboard, Telegram, and MT5 (if linked) — not limited to a forex pair list.',
      'In-app charts are display-only and may not have candles for every instrument. Chart feed issues never block alerts.',
      `This script was generated for ${subscriberLabel} (${tierLabel} plan).`
    ]
  };
}

module.exports = {
  generateForUser,
  escapePineString,
  buildScriptId,
  sampleWebhookPayload
};
