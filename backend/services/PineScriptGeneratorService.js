const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PATTERN_SCANNER_CONFIG } = require('../config/patternScanner');
const { generateLicenseToken } = require('../utils/webhookSecurity');
const { getTierDisplayName } = require('../utils/subscriptionAccess');

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

function generateForUser(user, options = {}) {
  const userId = user._id?.toString() || user.id || '';
  const subscription = user.subscription || {};
  const tier = subscription.tier || 'basic';
  const risk = PATTERN_SCANNER_CONFIG.risk || {};
  const webhookUrl =
    options.webhookUrl ||
    `${options.publicBackendUrl || process.env.PUBLIC_BACKEND_URL || 'http://localhost:4000'}/api/webhook/tradingview`;
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
    INDICATOR_TITLE: escapePineString(`KachingFx Scanner (${tierLabel})`),
    SUBSCRIBER_LABEL: escapePineString(subscriberLabel),
    SUBSCRIPTION_TIER: escapePineString(tierLabel),
    SCRIPT_ID: escapePineString(scriptId),
    WEBHOOK_URL: escapePineString(webhookUrl),
    WEBHOOK_SECRET: escapePineString(webhookSecret),
    LICENSE_TOKEN: escapePineString(licenseToken),
    TV_USERNAME: escapePineString(tvUsername),
    SUBSCRIBER_ID: escapePineString(userId),
    SEND_CANDLE_FEED: 'true',
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
    security: {
      licenseTokenIncluded: Boolean(licenseToken),
      signatureHeader: 'X-Kaching-Signature',
      signatureFormat: 'sha256=<hmac_hex_of_raw_body>'
    },
    instructions: [
      'Open TradingView → Pine Editor → New → paste this script and save it to your chart.',
      'Create alerts for Kaching Entry, Kaching SL, Kaching TP1, Kaching TP2, and Kaching TP3.',
      'Each alert payload includes your personal licenseToken — do not share your generated script.',
      'Set alert notification to Webhook URL and use the webhook URL pre-filled in the script settings.',
      'Enable TradingView push or email notifications for instant delivery.',
      `This script was generated for ${subscriberLabel} (${tierLabel} plan).`
    ]
  };
}

module.exports = {
  generateForUser,
  escapePineString,
  buildScriptId
};
