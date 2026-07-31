/**
 * Focused unit tests for ActivationService pure logic + duplicate-reference guard shape.
 * DB integration paths are covered via helper contracts; no live Mongo required.
 */
const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');

// Ensure mailer side-effects are inert if ActivationService loads it.
process.env.SMTP_HOST = '';
process.env.RESEND_API_KEY = '';

const {
  normalizeMpesaCode,
  mapPaymentSource,
  submitManualPaymentRequest
} = require('../ActivationService');

describe('Manual payment request validation (no DB)', () => {
  it('rejects invalid M-Pesa codes before hitting the database', async () => {
    await assert.rejects(
      () =>
        submitManualPaymentRequest({
          userId: '64b0f0f0f0f0f0f0f0f0f0aa',
          tier: 'basic',
          mpesaCode: 'SHORT',
          phoneNumber: '254712345678',
          amount: 5000
        }),
      err => err.status === 400 && /M-Pesa/i.test(err.message)
    );
  });

  it('rejects invalid phone numbers', async () => {
    await assert.rejects(
      () =>
        submitManualPaymentRequest({
          userId: '64b0f0f0f0f0f0f0f0f0f0aa',
          tier: 'basic',
          mpesaCode: 'QH7X2K9M1ABC',
          phoneNumber: 'abc',
          amount: 5000
        }),
      err => err.status === 400 && /phone/i.test(err.message)
    );
  });

  it('rejects invalid tiers', async () => {
    await assert.rejects(
      () =>
        submitManualPaymentRequest({
          userId: '64b0f0f0f0f0f0f0f0f0f0aa',
          tier: 'enterprise',
          mpesaCode: 'QH7X2K9M1ABC',
          phoneNumber: '254712345678',
          amount: 5000
        }),
      err => err.status === 400 && /plan/i.test(err.message)
    );
  });

  it('returns 503 when database is unavailable (duplicate path never reached)', async () => {
    await assert.rejects(
      () =>
        submitManualPaymentRequest({
          userId: '64b0f0f0f0f0f0f0f0f0f0aa',
          tier: 'basic',
          mpesaCode: 'QH7X2K9M1ABC',
          phoneNumber: '254712345678',
          amount: 5000
        }),
      err => err.status === 503
    );
  });
});

describe('Duplicate reference contract', () => {
  it('normalized codes collide case-insensitively', () => {
    assert.equal(normalizeMpesaCode('qh7x2k9m1abc'), normalizeMpesaCode('QH7X2K9M1ABC'));
  });

  it('manual_mpesa maps to MANUAL_MPESA paymentSource for activation audits', () => {
    assert.equal(mapPaymentSource('manual_mpesa'), 'MANUAL_MPESA');
  });
});

// silence unused mock import on older node
void mock;
