'use strict';

/**
 * Transactional + trade-alert email via SMTP2GO REST API.
 * Single provider path — no Resend / Nodemailer / Postmark.
 *
 * Success requires HTTP 2xx AND data.succeeded >= 1 AND data.failed === 0
 * with empty data.failures. HTTP 200 alone is not acceptance.
 */

const { FRONTEND_URL } = require('../config/appUrls');
const SubscriberSignalFormatter = require('../services/SubscriberSignalFormatter');

const APP_NAME = process.env.EMAIL_APP_NAME || 'KachingScanner';
const SMTP2GO_SEND_URL = 'https://api.smtp2go.com/v3/email/send';
const DEFAULT_TIMEOUT_MS = 15_000;

function getEmailFrom() {
  return String(process.env.EMAIL_FROM || `${APP_NAME} <noreply@kachingscanner.com>`).trim();
}

function getSmtp2goApiKey() {
  return String(process.env.SMTP2GO_API_KEY || '').trim() || null;
}

function getSmtp2goTimeoutMs() {
  const n = parseInt(process.env.SMTP2GO_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function isMailConfigured() {
  return Boolean(getSmtp2goApiKey() && getEmailFrom());
}

/** @deprecated Nodemailer SMTP removed; always false. Kept for caller compatibility. */
function isSmtpConfigured() {
  return false;
}

/** Trade-alert fan-out. Production sets EMAIL_TRADE_ALERTS_ENABLED in fly.toml. */
function tradeAlertsEnabled() {
  const raw = String(process.env.EMAIL_TRADE_ALERTS_ENABLED || 'true').toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

let bulkPausedUntilMs = 0;

const EMAIL_PROVIDER_ERROR = Object.freeze({
  RATE_LIMIT: 'rate_limit',
  UNKNOWN_429: 'unknown_429',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  INVALID: 'invalid',
  TIMEOUT: 'timeout',
  NOT_CONFIGURED: 'not_configured',
  PROVIDER_REJECTED: 'provider_rejected',
  OTHER: 'other'
});

/** @deprecated Use EMAIL_PROVIDER_ERROR. Alias for older tests/callers. */
const RESEND_ERROR = Object.freeze({
  DAILY_QUOTA: 'daily_quota',
  MONTHLY_QUOTA: 'monthly_quota',
  RATE_LIMIT: EMAIL_PROVIDER_ERROR.RATE_LIMIT,
  UNKNOWN_429: EMAIL_PROVIDER_ERROR.UNKNOWN_429,
  OTHER: EMAIL_PROVIDER_ERROR.OTHER
});

function msUntilNextUtcMidnight() {
  const now = Date.now();
  const next = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1
  );
  return Math.max(60_000, next - now);
}

function retryAfterMsFrom(response, body) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const sec = parseInt(header, 10);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  }
  const retryAfter = body?.retryAfter || body?.retry_after || body?.data?.retry_after;
  if (Number.isFinite(Number(retryAfter)) && Number(retryAfter) > 0) {
    return Number(retryAfter) * 1000;
  }
  return null;
}

function safeProviderErrorMessage(err, body) {
  const raw =
    body?.data?.error ||
    body?.error ||
    body?.message ||
    err?.message ||
    'email_provider_error';
  return String(raw).replace(/smtp2go[^\s]*/gi, '[redacted]').slice(0, 240);
}

/**
 * Classify SMTP2GO / HTTP email errors for retry + bulk pause decisions.
 */
function classifyEmailProviderError(err, extras = {}) {
  if (err?.classification && extras.reuse !== false && !extras.body && !extras.response) {
    return err.classification;
  }
  const body = extras.body != null ? extras.body : err?.body || {};
  const status = Number(
    extras.status || err?.status || err?.httpStatus || body?.statusCode || 0
  );
  const parsedRetry =
    extras.retryAfterMs != null ? extras.retryAfterMs : retryAfterMsFrom(extras.response, body);
  const requestId = body?.request_id || err?.requestId || null;
  const errorCode = body?.data?.error_code || body?.error_code || err?.errorCode || null;

  if (err?.code === 'EMAIL_PROVIDER_TIMEOUT' || /timeout/i.test(String(err?.message || ''))) {
    return {
      type: EMAIL_PROVIDER_ERROR.TIMEOUT,
      isGlobalQuota: false,
      retryAfterMs: null,
      status: status || 0,
      requestId,
      errorCode
    };
  }
  if (err?.code === 'SMTP2GO_NOT_CONFIGURED' || status === 0 && !getSmtp2goApiKey()) {
    return {
      type: EMAIL_PROVIDER_ERROR.NOT_CONFIGURED,
      isGlobalQuota: false,
      retryAfterMs: null,
      status: 0,
      requestId,
      errorCode
    };
  }
  if (status === 401) {
    return {
      type: EMAIL_PROVIDER_ERROR.UNAUTHORIZED,
      isGlobalQuota: false,
      retryAfterMs: null,
      status,
      requestId,
      errorCode
    };
  }
  if (status === 403) {
    return {
      type: EMAIL_PROVIDER_ERROR.FORBIDDEN,
      isGlobalQuota: false,
      retryAfterMs: null,
      status,
      requestId,
      errorCode
    };
  }
  if (status === 400 || status === 422) {
    return {
      type: EMAIL_PROVIDER_ERROR.INVALID,
      isGlobalQuota: false,
      retryAfterMs: null,
      status,
      requestId,
      errorCode
    };
  }
  if (status === 429) {
    return {
      type: EMAIL_PROVIDER_ERROR.RATE_LIMIT,
      isGlobalQuota: true,
      retryAfterMs: parsedRetry || 60_000,
      status,
      requestId,
      errorCode
    };
  }
  if (err?.code === 'SMTP2GO_SEND_REJECTED') {
    return {
      type: EMAIL_PROVIDER_ERROR.PROVIDER_REJECTED,
      isGlobalQuota: false,
      retryAfterMs: null,
      status: status || 200,
      requestId,
      errorCode
    };
  }
  return {
    type: EMAIL_PROVIDER_ERROR.OTHER,
    isGlobalQuota: false,
    retryAfterMs: null,
    status,
    requestId,
    errorCode
  };
}

/** @deprecated Alias — SMTP2GO classification. */
function classifyResendError(err, extras = {}) {
  return classifyEmailProviderError(err, extras);
}

function pauseBulkUntil(ms) {
  const until = Date.now() + Math.max(60_000, ms || msUntilNextUtcMidnight());
  if (until > bulkPausedUntilMs) {
    bulkPausedUntilMs = until;
    console.warn('[mailer] pausing bulk email until', new Date(bulkPausedUntilMs).toISOString());
  }
}

function maybePauseBulkForGlobalQuota(classification) {
  if (!classification?.isGlobalQuota) return;
  pauseBulkUntil(classification.retryAfterMs || 60_000);
}

function isBulkPaused() {
  return Date.now() < bulkPausedUntilMs;
}

function getBulkPausedUntilMsForTests() {
  return bulkPausedUntilMs;
}

function isQuotaError(err) {
  if (!err) return false;
  return Boolean(classifyEmailProviderError(err).isGlobalQuota);
}

function isPermanentEmailFailure(err) {
  const status = Number(err?.status || err?.httpStatus || 0);
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
    return true;
  }
  const type = classifyEmailProviderError(err).type;
  if (
    type === EMAIL_PROVIDER_ERROR.INVALID ||
    type === EMAIL_PROVIDER_ERROR.UNAUTHORIZED ||
    type === EMAIL_PROVIDER_ERROR.FORBIDDEN ||
    type === EMAIL_PROVIDER_ERROR.NOT_CONFIGURED ||
    type === EMAIL_PROVIDER_ERROR.PROVIDER_REJECTED
  ) {
    return true;
  }
  return /invalid.+email|not a valid|suppressed|bounce|blocked|unsubscribed/i.test(
    String(err?.message || err?.reason || '')
  );
}

function isImmediateRetryDisabled(err) {
  if (!err) return false;
  if (isQuotaError(err) || isPermanentEmailFailure(err)) return true;
  const classified = classifyEmailProviderError(err);
  return (
    classified.type === EMAIL_PROVIDER_ERROR.RATE_LIMIT ||
    classified.type === EMAIL_PROVIDER_ERROR.UNKNOWN_429 ||
    Number(err.status || classified.status || 0) === 429
  );
}

function resetMailerStateForTests() {
  bulkPausedUntilMs = 0;
}

function requireSmtp2goConfigured() {
  if (!getSmtp2goApiKey()) {
    const err = new Error('SMTP2GO_API_KEY is required — SMTP2GO is the email provider');
    err.code = 'SMTP2GO_NOT_CONFIGURED';
    err.status = 0;
    err.classification = classifyEmailProviderError(err);
    throw err;
  }
  if (!getEmailFrom()) {
    const err = new Error('EMAIL_FROM is required');
    err.code = 'EMAIL_FROM_MISSING';
    err.status = 0;
    throw err;
  }
}

function toRecipientList(to) {
  if (Array.isArray(to)) {
    return to.map(v => String(v || '').trim()).filter(Boolean);
  }
  const single = String(to || '').trim();
  return single ? [single] : [];
}

function assertSmtp2goAccepted(body, httpStatus) {
  const data = body && typeof body === 'object' ? body.data : null;
  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      reason: 'smtp2go_missing_data',
      succeeded: 0,
      failed: 1,
      failures: ['missing_data']
    };
  }
  const succeeded = Number(data.succeeded || 0);
  const failed = Number(data.failed || 0);
  const failures = Array.isArray(data.failures) ? data.failures : [];
  const httpOk = httpStatus >= 200 && httpStatus < 300;
  if (!httpOk || !(succeeded >= 1) || failed !== 0 || failures.length > 0) {
    return {
      ok: false,
      reason: 'smtp2go_send_rejected',
      succeeded,
      failed,
      failures
    };
  }
  return {
    ok: true,
    emailId: data.email_id != null ? String(data.email_id) : null,
    succeeded,
    failed,
    failures
  };
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ms = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sendViaSmtp2goApi({ to, subject, text, html, cc, bcc, replyTo }) {
  requireSmtp2goConfigured();
  const recipients = toRecipientList(to);
  if (!recipients.length) {
    const err = new Error('email recipient required');
    err.status = 400;
    err.code = 'EMAIL_RECIPIENT_MISSING';
    throw err;
  }

  const payload = {
    sender: getEmailFrom(),
    to: recipients,
    subject: String(subject || ''),
    text_body: text != null ? String(text) : undefined,
    html_body: html != null ? String(html) : undefined
  };
  if (cc) payload.cc = toRecipientList(cc);
  if (bcc) payload.bcc = toRecipientList(bcc);
  if (replyTo) {
    payload.custom_headers = [{ header: 'Reply-To', value: String(replyTo) }];
  }

  let response;
  try {
    response = await fetchWithTimeout(
      SMTP2GO_SEND_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Smtp2go-Api-Key': getSmtp2goApiKey()
        },
        body: JSON.stringify(payload)
      },
      getSmtp2goTimeoutMs()
    );
  } catch (err) {
    const aborted = err?.name === 'AbortError' || /aborted|timeout/i.test(String(err?.message || ''));
    const wrapped = new Error(aborted ? 'smtp2go_timeout' : safeProviderErrorMessage(err));
    wrapped.code = aborted ? 'EMAIL_PROVIDER_TIMEOUT' : 'EMAIL_PROVIDER_NETWORK';
    wrapped.status = 0;
    wrapped.classification = classifyEmailProviderError(wrapped);
    throw wrapped;
  }

  let body = {};
  try {
    body = await response.json();
  } catch {
    const err = new Error('smtp2go_malformed_json');
    err.status = response.status;
    err.code = 'SMTP2GO_MALFORMED_JSON';
    err.classification = classifyEmailProviderError(err, { status: response.status });
    throw err;
  }

  if (!response.ok) {
    const err = new Error(
      `SMTP2GO API ${response.status}: ${safeProviderErrorMessage(null, body)}`
    );
    err.status = response.status;
    err.body = body;
    err.requestId = body?.request_id || null;
    err.errorCode = body?.data?.error_code || body?.error_code || null;
    const classification = classifyEmailProviderError(err, {
      response,
      body,
      status: response.status
    });
    err.classification = classification;
    maybePauseBulkForGlobalQuota(classification);
    console.warn('[mailer] SMTP2GO send failed', {
      provider: 'smtp2go',
      status: response.status,
      requestId: err.requestId,
      errorCode: err.errorCode,
      message: safeProviderErrorMessage(err, body)
    });
    throw err;
  }

  const accepted = assertSmtp2goAccepted(body, response.status);
  if (!accepted.ok) {
    const err = new Error(
      `SMTP2GO rejected send (succeeded=${accepted.succeeded} failed=${accepted.failed})`
    );
    err.status = response.status;
    err.code = 'SMTP2GO_SEND_REJECTED';
    err.body = body;
    err.requestId = body?.request_id || null;
    err.classification = classifyEmailProviderError(err, {
      response,
      body,
      status: response.status
    });
    console.warn('[mailer] SMTP2GO logical failure on HTTP 2xx', {
      provider: 'smtp2go',
      status: response.status,
      requestId: err.requestId,
      succeeded: accepted.succeeded,
      failed: accepted.failed,
      failureCount: Array.isArray(accepted.failures) ? accepted.failures.length : 0
    });
    throw err;
  }

  console.log('[mailer] SMTP2GO accepted email', {
    to: recipients[0],
    id: accepted.emailId,
    subject,
    requestId: body?.request_id || null
  });
  return {
    provider: 'smtp2go',
    id: accepted.emailId,
    requestId: body?.request_id || null
  };
}

function backoffMs(attempt) {
  return Math.min(8000, 200 * 2 ** (attempt - 1));
}

async function sendMailWithRetry(payload, { maxAttempts = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sendMail(payload);
    } catch (err) {
      lastErr = err;
      if (isImmediateRetryDisabled(err) || attempt >= maxAttempts) {
        throw err;
      }
      await new Promise(r => setTimeout(r, backoffMs(attempt)));
    }
  }
  throw lastErr;
}

async function sendMail({
  to,
  subject,
  text,
  html,
  priority = 'transactional',
  cc,
  bcc,
  replyTo
} = {}) {
  const isBulk = priority === 'bulk';

  if (isBulk && !tradeAlertsEnabled()) {
    return { skipped: true, reason: 'trade_alerts_disabled' };
  }
  if (isBulk && isBulkPaused()) {
    console.warn('[mailer] bulk email skipped (quota circuit open)', { to, subject });
    return { skipped: true, reason: 'quota_circuit_open' };
  }

  if (!isMailConfigured()) {
    if (isBulk) {
      return { skipped: true, reason: 'mail_not_configured' };
    }
    console.warn('[mailer] SMTP2GO_API_KEY/EMAIL_FROM not configured — email not sent');
    return { skipped: true, reason: 'mail_not_configured' };
  }

  return sendViaSmtp2goApi({ to, subject, text, html, cc, bcc, replyTo });
}

function verificationLink(token) {
  return `${FRONTEND_URL.replace(/\/$/, '')}?verify=${encodeURIComponent(token)}`;
}

function resetLink(token) {
  return `${FRONTEND_URL.replace(/\/$/, '')}?reset=${encodeURIComponent(token)}`;
}

async function sendVerificationEmail({ to, token, displayName }) {
  const link = verificationLink(token);
  const name = displayName || to.split('@')[0];

  return sendMail({
    to,
    subject: `Verify your ${APP_NAME} account`,
    text: [
      `Hi ${name},`,
      '',
      `Thanks for registering with ${APP_NAME}.`,
      'Please verify your email address by opening this link:',
      link,
      '',
      'This link expires in 24 hours.',
      '',
      `If you did not create an account, you can ignore this email.`
    ].join('\n'),
    html: `
      <p>Hi ${name},</p>
      <p>Thanks for registering with <strong>${APP_NAME}</strong>.</p>
      <p><a href="${link}">Verify your email address</a></p>
      <p>This link expires in 24 hours.</p>
      <p>If you did not create an account, you can ignore this email.</p>
    `
  });
}

async function sendPasswordResetEmail({ to, token, displayName }) {
  const link = resetLink(token);
  const name = displayName || to.split('@')[0];

  return sendMail({
    to,
    subject: `Reset your ${APP_NAME} password`,
    text: [
      `Hi ${name},`,
      '',
      'We received a request to reset your password.',
      'Open this link to choose a new password:',
      link,
      '',
      'This link expires in 1 hour.',
      '',
      'If you did not request a password reset, you can ignore this email.'
    ].join('\n'),
    html: `
      <p>Hi ${name},</p>
      <p>We received a request to reset your password.</p>
      <p><a href="${link}">Choose a new password</a></p>
      <p>This link expires in 1 hour.</p>
      <p>If you did not request a password reset, you can ignore this email.</p>
    `
  });
}

async function sendTradeAlertEmail({ to, displayName, signal, presentation } = {}) {
  if (!to || !signal) return { ok: false, reason: 'missing_to_or_signal' };
  if (!tradeAlertsEnabled()) return { ok: false, reason: 'trade_alerts_disabled' };
  if (isBulkPaused()) return { ok: false, reason: 'quota_circuit_open' };

  const formatted =
    presentation && typeof presentation === 'object'
      ? presentation
      : SubscriberSignalFormatter.formatEmail(signal);

  if (formatted?.stale) {
    return { ok: false, reason: 'stale_entry' };
  }

  if (!formatted?.ok) {
    const fallback = formatted?.fallbackText || SubscriberSignalFormatter.FORMATTING_FALLBACK;
    const guard = SubscriberSignalFormatter.assertSafeSubscriberContent(fallback, {
      channel: 'email',
      symbol: formatted?.symbol || signal.symbol,
      alertType: formatted?.alertType || signal.alertType,
      safeId: formatted?.safeId
    });
    if (guard.blocked) {
      return { ok: false, reason: 'blocked_raw_payload' };
    }
    try {
      await sendMail({
        to,
        subject: 'Kaching trading alert',
        text: fallback,
        html: `<p>${fallback}</p>`,
        priority: 'bulk'
      });
    } catch (err) {
      console.warn('[mailer] trade-alert fallback email failed:', err.message);
    }
    return { ok: false, reason: formatted?.reason || 'formatting_failed', sentFallback: true };
  }

  const subjectGuard = SubscriberSignalFormatter.assertSafeSubscriberContent(formatted.subject, {
    channel: 'email',
    symbol: formatted.symbol,
    alertType: formatted.alertType,
    safeId: formatted.safeId
  });
  const bodyGuard = SubscriberSignalFormatter.assertSafeSubscriberContent(formatted.text, {
    channel: 'email',
    symbol: formatted.symbol,
    alertType: formatted.alertType,
    safeId: formatted.safeId
  });
  if (subjectGuard.blocked || bodyGuard.blocked) {
    return { ok: false, reason: 'blocked_raw_payload' };
  }

  void displayName;
  const info = await sendMailWithRetry({
    to,
    subject: formatted.subject,
    text: formatted.text,
    html: formatted.html || `<pre>${formatted.text}</pre>`,
    priority: 'bulk'
  });
  if (info?.skipped) {
    return { ok: false, reason: info.reason, presentation: formatted };
  }
  return { ok: true, ...info, presentation: formatted };
}

async function sendSubscriptionActivatedEmail({
  to,
  displayName,
  planName,
  activationDate,
  expiryDate
}) {
  if (!to) return null;

  const name = displayName || String(to).split('@')[0];
  const plan = planName || 'your plan';
  const activated = activationDate ? new Date(activationDate).toLocaleString() : 'now';
  const expires = expiryDate ? new Date(expiryDate).toLocaleString() : '—';
  const dashboardUrl = FRONTEND_URL.replace(/\/$/, '');

  return sendMail({
    to,
    subject: `${APP_NAME}: Subscription Activated — ${plan}`,
    text: [
      `Hi ${name},`,
      '',
      `Thank you for subscribing to ${APP_NAME}.`,
      '',
      `Plan: ${plan}`,
      `Activated: ${activated}`,
      `Expires: ${expires}`,
      '',
      'Your account now has full access to live alerts and premium features.',
      `Open your dashboard: ${dashboardUrl}`,
      '',
      'Welcome aboard — happy trading!'
    ].join('\n'),
    html: `
      <p>Hi ${name},</p>
      <p>Thank you for subscribing to <strong>${APP_NAME}</strong>.</p>
      <ul>
        <li><strong>Plan:</strong> ${plan}</li>
        <li><strong>Activated:</strong> ${activated}</li>
        <li><strong>Expires:</strong> ${expires}</li>
      </ul>
      <p>Your account now has full access to live alerts and premium features.</p>
      <p><a href="${dashboardUrl}">Open your dashboard</a></p>
      <p>Welcome aboard — happy trading!</p>
    `
  });
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendTradeAlertEmail,
  sendSubscriptionActivatedEmail,
  sendMail,
  isSmtpConfigured,
  isMailConfigured,
  isQuotaError,
  isPermanentEmailFailure,
  classifyEmailProviderError,
  classifyResendError,
  isBulkPaused,
  getBulkPausedUntilMsForTests,
  tradeAlertsEnabled,
  resetMailerStateForTests,
  assertSmtp2goAccepted,
  EMAIL_PROVIDER_ERROR,
  RESEND_ERROR
};
