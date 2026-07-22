const nodemailer = require('nodemailer');
const { FRONTEND_URL } = require('../config/appUrls');

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

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  isSmtpConfigured,
  isMailConfigured
};
