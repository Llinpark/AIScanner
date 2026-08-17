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
  normalizeBinanceTxId,
  normalizeManualMethod,
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

  it('rejects invalid Binance transaction IDs before hitting the database', async () => {
    await assert.rejects(
      () =>
        submitManualPaymentRequest({
          userId: '64b0f0f0f0f0f0f0f0f0f0aa',
          tier: 'basic',
          method: 'manual_binance',
          binanceTxId: 'AB',
          amount: 55
        }),
      err => err.status === 400 && /Binance/i.test(err.message)
    );
  });

  it('rejects invalid phone numbers for M-Pesa', async () => {
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

  it('allows missing phone for Binance claims (fails later at DB readiness)', async () => {
    await assert.rejects(
      () =>
        submitManualPaymentRequest({
          userId: '64b0f0f0f0f0f0f0f0f0f0aa',
          tier: 'professional',
          method: 'binance',
          binanceTxId: '123456789012345678',
          amount: 138.82
        }),
      err => err.status === 503
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
    assert.equal(normalizeBinanceTxId(' ab-12cd '), normalizeBinanceTxId('AB-12CD'));
  });

  it('normalizes method aliases to manual providers', () => {
    assert.equal(normalizeManualMethod('binance'), 'manual_binance');
    assert.equal(normalizeManualMethod('manual-binance'), 'manual_binance');
    assert.equal(normalizeManualMethod('mpesa'), 'manual_mpesa');
  });

  it('manual providers map to paymentSource for activation audits', () => {
    assert.equal(mapPaymentSource('manual_mpesa'), 'MANUAL_MPESA');
    assert.equal(mapPaymentSource('manual_binance'), 'MANUAL_BINANCE');
  });
});

// silence unused mock import on older node
void mock;
