/**
 * Safe TradingView → Telegram pipeline diagnostics helpers.
 * Never logs secrets (licenseToken, bot token, HMAC secrets, passwords).
 */

const crypto = require('crypto');

const PIPELINE_INTAKE_STATE = Object.freeze({
  NO_WEBHOOK_RECEIVED: 'NO_WEBHOOK_RECEIVED',
  WEBHOOK_RECEIVED_AUTH_FAILED: 'WEBHOOK_RECEIVED_AUTH_FAILED',
  WEBHOOK_PARSE_FAILED: 'WEBHOOK_PARSE_FAILED',
  WEBHOOK_SCHEMA_FAILED: 'WEBHOOK_SCHEMA_FAILED',
  SIGNAL_PERSIST_FAILED: 'SIGNAL_PERSIST_FAILED',
  NO_ELIGIBLE_SUBSCRIBERS: 'NO_ELIGIBLE_SUBSCRIBERS',
  TELEGRAM_DELIVERY_FAILED: 'TELEGRAM_DELIVERY_FAILED',
  TELEGRAM_SUCCESS: 'TELEGRAM_SUCCESS',
  PIPELINE_ACTIVE: 'PIPELINE_ACTIVE'
});

/** Short correlation id for one TradingView webhook attempt (never a secret). */
function createRequestId() {
  return `tvw_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function ensureRequestId(req) {
  if (!req) return createRequestId();
  if (req.pipelineRequestId) return req.pipelineRequestId;
  req.pipelineRequestId = createRequestId();
  return req.pipelineRequestId;
}

const SENSITIVE_KEY_RE =
  /^(licenseToken|license_token|secret|password|token|authorization|webhookSecret|botToken|TELEGRAM_BOT_TOKEN|WEBHOOK_SIGNING_SECRET|TRADINGVIEW_WEBHOOK_SECRET)$/i;

function redactValue(key, value) {
  if (SENSITIVE_KEY_RE.test(String(key || ''))) {
    // Preserve already-safe presence markers used by intake diagnostics.
    if (value === 'present' || value === 'absent') return value;
    if (value === true) return 'present';
    if (value === false) return 'absent';
    return value == null || value === '' ? 'absent' : 'present';
  }
  if (typeof value === 'string' && value.length > 240) {
    return `${value.slice(0, 120)}…[truncated ${value.length} chars]`;
  }
  return value;
}

function redactObject(input, depth = 0) {
  if (input == null || depth > 4) return input;
  if (Array.isArray(input)) return input.slice(0, 20).map(v => redactObject(v, depth + 1));
  if (typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = redactValue(k, v);
      continue;
    }
    out[k] = typeof v === 'object' && v != null ? redactObject(v, depth + 1) : redactValue(k, v);
  }
  return out;
}

function redactRawPreview(raw, maxLen = 160) {
  const text = String(raw || '');
  const scrubbed = text
    .replace(/"(licenseToken|license_token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
    .replace(/"(secret|password|token)"\s*:\s*"[^"]*"/gi, '"$1":"[REDACTED]"')
    .replace(/kls_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'kls_v1.[REDACTED]');
  if (scrubbed.length <= maxLen) return scrubbed;
  return `${scrubbed.slice(0, maxLen)}…[truncated]`;
}

/**
 * Classify TradingView webhook raw bodies that fail JSON parse.
 * Diagnostics only — never grants auth or invents a successful payload.
 *
 * Common TV misconfig: Alert Message left as a literal {{…}} placeholder while
 * Content-Type is application/json → express.json fails at position 1.
 */
function diagnoseTradingViewWebhookBody(raw) {
  const text = String(raw ?? '');
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return {
      reason: 'empty_body',
      kind: 'empty',
      hint:
        'TradingView sent an empty webhook body. Alert Message must deliver Pine alert() JSON — use Message={{alert_message}} with Condition: Any alert() function call (never leave a broken/empty Message).'
    };
  }

  const placeholderMatch = trimmed.match(/^\{\{\s*([^}]+?)\s*\}\}\s*$/);
  if (placeholderMatch || trimmed.startsWith('{{')) {
    const token = placeholderMatch ? placeholderMatch[1].trim() : trimmed.slice(0, 80);
    const isStrategy = /strategy\.order\.alert_message/i.test(token);
    const isAlertMessage = /alert_message/i.test(token) && !isStrategy;
    return {
      reason: 'unexpanded_tv_placeholder',
      kind: isStrategy
        ? 'strategy_placeholder'
        : isAlertMessage
          ? 'alert_message_placeholder'
          : 'tv_placeholder',
      placeholder: String(token).slice(0, 120),
      hint: isStrategy
        ? 'TradingView sent literal {{strategy.order.alert_message}} — that only expands for strategy() order fills. Kaching is an indicator: Condition → Any alert() function call, Message → {{alert_message}} only.'
        : isAlertMessage
          ? 'TradingView sent literal {{alert_message}} (unexpanded). Fix Alert Condition to: Kaching indicator → Any alert() function call, and keep Message exactly {{alert_message}} so Pine alert(json) is substituted.'
          : `TradingView sent an unexpanded placeholder starting with {{ (${String(token).slice(0, 60)}). Webhook body must be the Pine alert() JSON, not a literal {{…}} string.`
    };
  }

  return {
    reason: 'invalid_json',
    kind: 'malformed',
    hint:
      'Webhook body is not valid JSON. Do not type custom JSON in Alert Message — Pine alert() already builds the payload. Message should be exactly {{alert_message}}.'
  };
}

function safeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    if (
      key === 'authorization' ||
      key === 'cookie' ||
      key === 'x-telegram-bot-api-secret-token' ||
      key === 'x-tradingview-secret' ||
      key === 'x-kaching-signature' ||
      key === 'x-webhook-signature'
    ) {
      out[k] = v ? '[REDACTED]' : '';
      continue;
    }
    out[k] = v;
  }
  return out;
}

function logTvStage(tag, fields = {}) {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      const safe = redactValue(k, v);
      const text = safe == null || safe === '' ? 'n/a' : String(safe).replace(/\s+/g, ' ').trim();
      return `${k}=${text || 'n/a'}`;
    });
  console.log(`[${tag}] ${parts.join(' ')}`);
}

function resolveIntakeState(status = {}) {
  const lastFail = String(status.lastFailureStage || '');
  const lastFailReason = String(status.lastFailureReason || '');
  const hasWebhook = Boolean(status.lastWebhookReceived?.at || status.lastWebhook?.at);
  const hasTelegramOk = Boolean(status.lastTelegramDelivery?.at || status.lastTelegram?.at);
  const telegramFail = lastFail === 'DeliveryTelegram' || /telegram/i.test(lastFailReason);

  // Failure stages always win over "no webhook" — a failed attempt is not silence.
  if (
    /WebhookParseError/i.test(lastFail) ||
    /invalid_json|empty_body|unexpanded_tv_placeholder/i.test(lastFailReason)
  ) {
    return PIPELINE_INTAKE_STATE.WEBHOOK_PARSE_FAILED;
  }
  if (lastFail === 'Auth' || (/auth/i.test(lastFail) && !/parse/i.test(lastFailReason))) {
    return PIPELINE_INTAKE_STATE.WEBHOOK_RECEIVED_AUTH_FAILED;
  }
  if (lastFail === 'Validation' || /schema|validation|rejected_fields/i.test(lastFailReason)) {
    return PIPELINE_INTAKE_STATE.WEBHOOK_SCHEMA_FAILED;
  }
  if (lastFail === 'MongoSave' || /persist|mongo/i.test(lastFailReason)) {
    return PIPELINE_INTAKE_STATE.SIGNAL_PERSIST_FAILED;
  }
  if (lastFail === 'Broadcast' || /no_eligible|NO_ELIGIBLE/i.test(lastFailReason)) {
    return PIPELINE_INTAKE_STATE.NO_ELIGIBLE_SUBSCRIBERS;
  }
  if (telegramFail) return PIPELINE_INTAKE_STATE.TELEGRAM_DELIVERY_FAILED;
  if (hasTelegramOk) return PIPELINE_INTAKE_STATE.TELEGRAM_SUCCESS;
  if (hasWebhook) return PIPELINE_INTAKE_STATE.PIPELINE_ACTIVE;
  if (!hasWebhook && !lastFail) return PIPELINE_INTAKE_STATE.NO_WEBHOOK_RECEIVED;
  return PIPELINE_INTAKE_STATE.NO_WEBHOOK_RECEIVED;
}

/**
 * Map verifyTradingViewWebhook result → HTTP status + intake state (for tests + route parity).
 * Does not weaken auth — only classifies already-computed auth outcomes.
 */
function classifyWebhookGate(authResult = {}) {
  if (authResult.ok) {
    return {
      httpStatus: 200,
      intakeState: PIPELINE_INTAKE_STATE.PIPELINE_ACTIVE,
      stage: 'AUTH_PASS',
      reason: authResult.mode || 'ok'
    };
  }
  const reason = authResult.reason || 'unauthorized';
  if (
    authResult.parseError ||
    reason === 'invalid_json' ||
    reason === 'empty_body' ||
    reason === 'unexpanded_tv_placeholder'
  ) {
    return {
      httpStatus: 400,
      intakeState: PIPELINE_INTAKE_STATE.WEBHOOK_PARSE_FAILED,
      stage: 'PARSE_FAIL',
      reason
    };
  }
  return {
    httpStatus: 401,
    intakeState: PIPELINE_INTAKE_STATE.WEBHOOK_RECEIVED_AUTH_FAILED,
    stage: 'AUTH_FAIL',
    reason
  };
}

module.exports = {
  PIPELINE_INTAKE_STATE,
  createRequestId,
  ensureRequestId,
  redactObject,
  redactRawPreview,
  redactValue,
  diagnoseTradingViewWebhookBody,
  safeHeaders,
  logTvStage,
  resolveIntakeState,
  classifyWebhookGate
};
