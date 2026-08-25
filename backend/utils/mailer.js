const nodemailer = require('nodemailer');
const { FRONTEND_URL } = require('../config/appUrls');
const SubscriberSignalFormatter = require('../services/SubscriberSignalFormatter');

const APP_NAME = process.env.EMAIL_APP_NAME || 'KachingScanner';
const EMAIL_FROM = process.env.EMAIL_FROM || `${APP_NAME} <noreply@kachingscanner.com>`;

function getResendApiKey() {
  return (
    process.env.RESEND_API_KEY ||
    (String(process.env.SMTP_HOST || '').includes('resend.com') ? process.env.SMTP_PASS : null) ||
    null
  );
}

function isSmtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function isMailConfigured() {
  return Boolean(getResendApiKey() || isSmtpConfigured());
}

/** Trade-alert fan-out. Production sets EMAIL_TRADE_ALERTS_ENABLED in fly.toml. */
function tradeAlertsEnabled() {
  const raw = String(process.env.EMAIL_TRADE_ALERTS_ENABLED || 'true').toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'off';
}

let bulkPausedUntilMs = 0;

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
  const retryAfter = body?.retryAfter || body?.retry_after;
  if (Number.isFinite(Number(retryAfter)) && Number(retryAfter) > 0) {
    return Number(retryAfter) * 1000;
  }
  return msUntilNextUtcMidnight();
}

function pauseBulkUntil(ms) {
  const until = Date.now() + Math.max(60_000, ms || msUntilNextUtcMidnight());
  if (until > bulkPausedUntilMs) {
    bulkPausedUntilMs = until;
    console.warn('[mailer] pausing bulk email until', new Date(bulkPausedUntilMs).toISOString());
  }
}

function isBulkPaused() {
  return Date.now() < bulkPausedUntilMs;
}

function isQuotaError(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  return /quota|daily_quota|rate.?limit/i.test(String(err.message || ''));
}

function resetMailerStateForTests() {
  bulkPausedUntilMs = 0;
  transportPromise = null;
}

function createTransport() {
  if (!isSmtpConfigured()) return null;

  const port = parseInt(process.env.SMTP_PORT, 10) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    requireTLS: port === 587,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

let transportPromise = null;

async function getTransport() {
  if (!isSmtpConfigured()) return null;
  if (!transportPromise) {
    transportPromise = Promise.resolve(createTransport());
  }
  return transportPromise;
}

async function sendViaResendApi({ to, subject, text, html }) {
  const apiKey = getResendApiKey();
  if (!apiKey) return null;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [to],
      subject,
      text,
      html
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.message || body?.error || response.statusText || 'Resend API error';
    const err = new Error(`Resend API ${response.status}: ${detail}`);
    err.status = response.status;
    err.body = body;
    if (response.status === 429 || isQuotaError(err)) {
      pauseBulkUntil(retryAfterMsFrom(response, body));
    }
    throw err;
  }

  console.log('[mailer] Resend API accepted email', { to, id: body.id, subject });
  return { provider: 'resend_api', id: body.id };
}

function isPermanentEmailFailure(err) {
  const status = Number(err?.status || err?.httpStatus || 0);
  if (status === 400 || status === 403 || status === 404 || status === 422) return true;
  return /invalid.+email|not a valid|suppressed|bounce|blocked|unsubscribed/i.test(
    String(err?.message || err?.reason || '')
  );
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
      if (isQuotaError(err) || isPermanentEmailFailure(err) || attempt >= maxAttempts) {
        throw err;
      }
      await new Promise(r => setTimeout(r, backoffMs(attempt)));
    }
  }
  throw lastErr;
}

async function sendMail({ to, subject, text, html, priority = 'transactional' }) {
  const payload = { from: EMAIL_FROM, to, subject, text, html };
  const isBulk = priority === 'bulk';

  if (isBulk && !tradeAlertsEnabled()) {
    return { skipped: true, reason: 'trade_alerts_disabled' };
  }
  if (isBulk && isBulkPaused()) {
    console.warn('[mailer] bulk email skipped (quota circuit open)', { to, subject });
    return { skipped: true, reason: 'quota_circuit_open' };
  }

  // Prefer Resend HTTPS API — Fly.io often blocks outbound SMTP ports.
  if (getResendApiKey()) {
    return sendViaResendApi({ to, subject, text, html });
  }

  const transport = await getTransport();
  if (!transport) {
    console.warn('[mailer] SMTP/Resend not configured — email logged to console:');
    console.log(JSON.stringify({ to, subject, text }, null, 2));
    return { logged: true };
  }

  const info = await transport.sendMail(payload);
  console.log('[mailer] SMTP accepted email', { to, messageId: info.messageId, subject });
  return { provider: 'smtp', id: info.messageId };
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
      if (isQuotaError(err)) pauseBulkUntil(msUntilNextUtcMidnight());
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
  try {
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
  } catch (err) {
    if (isQuotaError(err)) pauseBulkUntil(msUntilNextUtcMidnight());
    throw err;
  }
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
  isSmtpConfigured,
  isMailConfigured,
  isQuotaError,
  isPermanentEmailFailure,
  tradeAlertsEnabled,
  resetMailerStateForTests
};
