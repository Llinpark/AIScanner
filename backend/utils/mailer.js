const nodemailer = require('nodemailer');
const { FRONTEND_URL } = require('../config/appUrls');
const { formatTvPrice } = require('./priceFormat');

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
    throw err;
  }

  console.log('[mailer] Resend API accepted email', { to, id: body.id, subject });
  return { provider: 'resend_api', id: body.id };
}

async function sendMail({ to, subject, text, html }) {
  const payload = { from: EMAIL_FROM, to, subject, text, html };

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

async function sendTradeAlertEmail({ to, displayName, signal }) {
  if (!to || !signal) return null;

  const name = displayName || String(to).split('@')[0];
  const direction = String(signal.direction || '').toUpperCase();
  const sl = signal.stop_loss_1 ?? signal.stop_loss;
  const title = `${signal.symbol || 'Signal'} ${direction}`.trim();
  const subject = `${APP_NAME} alert: ${title}`;

  const lines = [
    `Hi ${name},`,
    '',
    `New ${APP_NAME} trade alert`,
    `Symbol: ${signal.symbol || '—'}`,
    `Direction: ${direction || '—'}`,
    `Entry: ${formatTvPrice(signal.entry)}`,
    `SL: ${formatTvPrice(sl)}`,
    `TP1: ${formatTvPrice(signal.take_profit_1)}`,
    `TP2: ${formatTvPrice(signal.take_profit_2)}`,
    `TP3: ${formatTvPrice(signal.take_profit_3)}`,
    '',
    `Open your dashboard: ${FRONTEND_URL.replace(/\/$/, '')}`
  ];

  return sendMail({
    to,
    subject,
    text: lines.join('\n'),
    html: `
      <p>Hi ${name},</p>
      <p><strong>New ${APP_NAME} trade alert</strong></p>
      <ul>
        <li><strong>Symbol:</strong> ${signal.symbol || '—'}</li>
        <li><strong>Direction:</strong> ${direction || '—'}</li>
        <li><strong>Entry:</strong> ${formatTvPrice(signal.entry)}</li>
        <li><strong>SL:</strong> ${formatTvPrice(sl)}</li>
        <li><strong>TP1:</strong> ${formatTvPrice(signal.take_profit_1)}</li>
        <li><strong>TP2:</strong> ${formatTvPrice(signal.take_profit_2)}</li>
        <li><strong>TP3:</strong> ${formatTvPrice(signal.take_profit_3)}</li>
      </ul>
      <p><a href="${FRONTEND_URL.replace(/\/$/, '')}">Open your dashboard</a></p>
    `
  });
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
  isMailConfigured
};
