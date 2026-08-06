/**
 * Pure helpers for production pipeline observability (diagnostics only).
 * No strategy / auth / delivery behaviour changes.
 */

const DEFAULT_THRESHOLDS_MS = {
  scalping: 20 * 60 * 1000,
  daytrading: 3 * 60 * 60 * 1000,
  swing: 12 * 60 * 60 * 1000
};

const NO_ACTIVITY_WARNING = '⚠ No TradingView activity detected';
const WAITING_FIRST_WEBHOOK = 'Waiting for first TradingView webhook';
const ALERT_RECREATE_REMINDER =
  '⚠ Pine regenerated. TradingView alert probably needs to be recreated.';

function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getWebhookAgeThresholdsMs() {
  return {
    scalping: envMs('WEBHOOK_AGE_SCALPING_MS', DEFAULT_THRESHOLDS_MS.scalping),
    daytrading: envMs('WEBHOOK_AGE_DAYTRADING_MS', DEFAULT_THRESHOLDS_MS.daytrading),
    swing: envMs('WEBHOOK_AGE_SWING_MS', DEFAULT_THRESHOLDS_MS.swing)
  };
}

function normalizeStrategyKey(strategy) {
  const s = String(strategy || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (s.includes('scalp')) return 'scalping';
  if (s.includes('swing')) return 'swing';
  if (s.includes('day')) return 'daytrading';
  return 'daytrading';
}

function getWebhookAgeThresholdMs(strategy) {
  const key = normalizeStrategyKey(strategy);
  const thresholds = getWebhookAgeThresholdsMs();
  return thresholds[key] || thresholds.daytrading;
}

/**
 * @param {Date|string|number|null} lastWebhookAt
 * @param {{ strategy?: string, now?: number, pineGeneratedAt?: Date|string|null }} [opts]
 */
function evaluateWebhookAge(lastWebhookAt, opts = {}) {
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const thresholdMs = getWebhookAgeThresholdMs(opts.strategy);
  if (!lastWebhookAt) {
    return {
      status: 'waiting',
      message: WAITING_FIRST_WEBHOOK,
      warning: false,
      ageMs: null,
      thresholdMs,
      lastWebhookAt: null
    };
  }
  const at = new Date(lastWebhookAt).getTime();
  if (!Number.isFinite(at)) {
    return {
      status: 'waiting',
      message: WAITING_FIRST_WEBHOOK,
      warning: false,
      ageMs: null,
      thresholdMs,
      lastWebhookAt: null
    };
  }
  const ageMs = Math.max(0, now - at);
  if (ageMs > thresholdMs) {
    return {
      status: 'stale',
      message: NO_ACTIVITY_WARNING,
      warning: true,
      ageMs,
      thresholdMs,
      lastWebhookAt: new Date(at).toISOString()
    };
  }
  return {
    status: 'ok',
    message: null,
    warning: false,
    ageMs,
    thresholdMs,
    lastWebhookAt: new Date(at).toISOString()
  };
}

/**
 * Alert-engine reminder when Pine was regenerated after the last webhook
 * (or pine exists and no webhook ever arrived).
 */
function evaluateAlertEngineReminder(lastPineGeneratedAt, lastWebhookAt, opts = {}) {
  const now = opts.now != null ? Number(opts.now) : Date.now();
  if (!lastPineGeneratedAt) {
    return { remind: false, message: null, reason: 'no_pine_generation' };
  }
  const pineAt = new Date(lastPineGeneratedAt).getTime();
  if (!Number.isFinite(pineAt)) {
    return { remind: false, message: null, reason: 'invalid_pine_time' };
  }
  if (!lastWebhookAt) {
    return {
      remind: true,
      message: ALERT_RECREATE_REMINDER,
      reason: 'never_received_webhook',
      pineGeneratedAt: new Date(pineAt).toISOString(),
      lastWebhookAt: null,
      evaluatedAt: new Date(now).toISOString()
    };
  }
  const webhookAt = new Date(lastWebhookAt).getTime();
  if (!Number.isFinite(webhookAt) || pineAt > webhookAt) {
    return {
      remind: true,
      message: ALERT_RECREATE_REMINDER,
      reason: 'pine_newer_than_webhook',
      pineGeneratedAt: new Date(pineAt).toISOString(),
      lastWebhookAt: Number.isFinite(webhookAt) ? new Date(webhookAt).toISOString() : null,
      evaluatedAt: new Date(now).toISOString()
    };
  }
  return {
    remind: false,
    message: null,
    reason: 'webhook_after_pine',
    pineGeneratedAt: new Date(pineAt).toISOString(),
    lastWebhookAt: new Date(webhookAt).toISOString()
  };
}

const TIMELINE_STAGES = [
  {
    id: 'pine_generated',
    label: 'Pine Generated',
    knownFromBackend: true
  },
  {
    id: 'tv_alert_created',
    label: 'TV Alert Created',
    knownFromBackend: false,
    unknownNote:
      'TradingView Alert Engine is client-side — recreate the alert after regenerating Pine. Backend cannot observe alert creation.'
  },
  {
    id: 'entry_detected',
    label: 'Entry Detected',
    knownFromBackend: false,
    unknownNote:
      'Pine-only until webhook arrives. Enable DEBUG_MODE and check Pine Logs for [PIPELINE] evaluation.'
  },
  {
    id: 'alert_fired',
    label: 'alert()',
    knownFromBackend: false,
    unknownNote:
      'Pine alert() is not visible server-side. First successful webhook is the proxy for alert fired.'
  },
  {
    id: 'tv_post',
    label: 'TV POST',
    knownFromBackend: false,
    unknownNote: 'TradingView HTTP POST is inferred from Webhook Received.'
  },
  {
    id: 'webhook_received',
    label: 'Webhook Received',
    knownFromBackend: true
  },
  {
    id: 'auth',
    label: 'Auth',
    knownFromBackend: true
  },
  {
    id: 'validation',
    label: 'Validation',
    knownFromBackend: true
  },
  {
    id: 'mongo_saved',
    label: 'Mongo Saved',
    knownFromBackend: true
  },
  {
    id: 'redis_published',
    label: 'Redis Published',
    knownFromBackend: true
  },
  {
    id: 'socket',
    label: 'Socket',
    knownFromBackend: true
  },
  {
    id: 'telegram',
    label: 'Telegram',
    knownFromBackend: true
  },
  {
    id: 'mt5',
    label: 'MT5',
    knownFromBackend: true
  }
];

function stageTone(status) {
  if (status === 'ok' || status === 'pass' || status === 'green') return 'green';
  if (status === 'warn' || status === 'yellow' || status === 'unknown' || status === 'waiting') {
    return 'yellow';
  }
  if (status === 'fail' || status === 'red' || status === 'error') return 'red';
  return 'yellow';
}

/**
 * Build admin timeline from best-available backend timestamps.
 * @param {object} snapshot
 */
function buildPipelineTimeline(snapshot = {}) {
  const s = snapshot || {};
  const stages = [];

  const push = (def, patch) => {
    const status = patch.status || (def.knownFromBackend ? 'unknown' : 'unknown');
    stages.push({
      id: def.id,
      label: def.label,
      knownFromBackend: def.knownFromBackend,
      status,
      tone: stageTone(status),
      at: patch.at || null,
      durationMs: patch.durationMs != null ? patch.durationMs : null,
      note: patch.note || (status === 'unknown' ? def.unknownNote || null : null)
    });
  };

  push(TIMELINE_STAGES[0], {
    status: s.pineGeneratedAt ? 'ok' : 'unknown',
    at: s.pineGeneratedAt || null,
    note: s.pineGeneratedAt
      ? null
      : 'No Pine generation recorded yet for this subscriber.'
  });

  const pineNewer =
    s.pineGeneratedAt &&
    (!s.lastWebhookAt || new Date(s.pineGeneratedAt).getTime() > new Date(s.lastWebhookAt).getTime());

  push(TIMELINE_STAGES[1], {
    status: pineNewer ? 'warn' : s.lastWebhookAt ? 'unknown' : 'unknown',
    at: null,
    note: pineNewer
      ? ALERT_RECREATE_REMINDER
      : TIMELINE_STAGES[1].unknownNote
  });

  push(TIMELINE_STAGES[2], {
    status: 'unknown',
    at: null
  });

  push(TIMELINE_STAGES[3], {
    status: s.lastWebhookAt ? 'ok' : 'unknown',
    at: s.lastAlertFiredAt || (s.lastWebhookAt ? s.lastWebhookAt : null),
    note: s.lastWebhookAt
      ? 'Inferred from first/latest webhook receive (Pine alert() not observed).'
      : TIMELINE_STAGES[3].unknownNote
  });

  push(TIMELINE_STAGES[4], {
    status: s.lastWebhookAt ? 'ok' : 'unknown',
    at: s.lastWebhookAt || null,
    note: s.lastWebhookAt ? 'Inferred from webhook receive.' : TIMELINE_STAGES[4].unknownNote
  });

  const webhookAt = s.lastWebhookAt ? new Date(s.lastWebhookAt).getTime() : null;
  const authAt = s.lastAuthAt ? new Date(s.lastAuthAt).getTime() : null;
  const mongoAt = s.lastMongoSaveAt ? new Date(s.lastMongoSaveAt).getTime() : null;
  const publishAt = s.lastPublishedAt ? new Date(s.lastPublishedAt).getTime() : null;
  const socketAt = s.lastSocketAt ? new Date(s.lastSocketAt).getTime() : null;
  const tgAt = s.lastTelegramAt ? new Date(s.lastTelegramAt).getTime() : null;
  const mt5At = s.lastMT5At ? new Date(s.lastMT5At).getTime() : null;

  push(TIMELINE_STAGES[5], {
    status: s.lastWebhookAt ? 'ok' : s.lastWebhookFail ? 'fail' : 'waiting',
    at: s.lastWebhookAt || null,
    note: !s.lastWebhookAt ? WAITING_FIRST_WEBHOOK : null
  });

  push(TIMELINE_STAGES[6], {
    status: s.lastAuthFail ? 'fail' : s.lastAuthAt ? 'ok' : 'unknown',
    at: s.lastAuthAt || null,
    durationMs: webhookAt && authAt ? Math.max(0, authAt - webhookAt) : null,
    note: s.lastAuthFailReason || null
  });

  push(TIMELINE_STAGES[7], {
    status: s.lastValidationFail ? 'fail' : s.lastValidationAt ? 'ok' : 'unknown',
    at: s.lastValidationAt || null,
    note: s.lastValidationFailReason || null
  });

  push(TIMELINE_STAGES[8], {
    status: s.lastMongoFail ? 'fail' : s.lastMongoSaveAt ? 'ok' : 'unknown',
    at: s.lastMongoSaveAt || null,
    durationMs: webhookAt && mongoAt ? Math.max(0, mongoAt - webhookAt) : null
  });

  push(TIMELINE_STAGES[9], {
    status: s.lastPublishFail ? 'fail' : s.lastPublishedAt ? 'ok' : 'unknown',
    at: s.lastPublishedAt || null,
    durationMs: mongoAt && publishAt ? Math.max(0, publishAt - mongoAt) : null,
    note: 'Redis publish / signal fan-out (Publish stage).'
  });

  push(TIMELINE_STAGES[10], {
    status: s.lastSocketFail ? 'fail' : s.lastSocketAt ? 'ok' : 'unknown',
    at: s.lastSocketAt || null
  });

  push(TIMELINE_STAGES[11], {
    status: s.lastTelegramFail ? 'fail' : s.lastTelegramAt ? 'ok' : 'unknown',
    at: s.lastTelegramAt || null,
    durationMs: mongoAt && tgAt ? Math.max(0, tgAt - mongoAt) : null
  });

  push(TIMELINE_STAGES[12], {
    status: s.lastMT5Fail ? 'fail' : s.lastMT5At ? 'ok' : 'unknown',
    at: s.lastMT5At || null,
    durationMs: mongoAt && mt5At ? Math.max(0, mt5At - mongoAt) : null
  });

  return stages;
}

function avg(nums) {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function summarizeLatencies(samples = []) {
  const ms = samples.map(Number).filter(n => Number.isFinite(n) && n >= 0);
  if (!ms.length) {
    return { avgMs: null, fastestMs: null, slowestMs: null, samples: 0 };
  }
  return {
    avgMs: Math.round(avg(ms)),
    fastestMs: Math.min(...ms),
    slowestMs: Math.max(...ms),
    samples: ms.length
  };
}

function percent(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

module.exports = {
  DEFAULT_THRESHOLDS_MS,
  NO_ACTIVITY_WARNING,
  WAITING_FIRST_WEBHOOK,
  ALERT_RECREATE_REMINDER,
  TIMELINE_STAGES,
  getWebhookAgeThresholdsMs,
  getWebhookAgeThresholdMs,
  normalizeStrategyKey,
  evaluateWebhookAge,
  evaluateAlertEngineReminder,
  buildPipelineTimeline,
  summarizeLatencies,
  percent,
  stageTone
};
