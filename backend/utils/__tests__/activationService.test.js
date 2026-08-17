const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMpesaCode,
  mapPaymentSource,
  remainingDaysFrom,
  serializeSubscription,
  applyActiveSubscriptionFields
} = require('../../services/ActivationService');
const {
  isSubscriptionActive,
  canAccessLiveAlerts,
  getEffectiveSubscription,
  userCanAccessLiveAlerts
} = require('../subscriptionAccess');

describe('ActivationService helpers', () => {
  it('normalizes M-Pesa codes to uppercase without spaces', () => {
    assert.equal(normalizeMpesaCode(' qh7x 2k9m1a '), 'QH7X2K9M1A');
  });

  it('maps payment methods to paymentSource constants', () => {
    assert.equal(mapPaymentSource('manual_mpesa'), 'MANUAL_MPESA');
    assert.equal(mapPaymentSource('manual_binance'), 'MANUAL_BINANCE');
    assert.equal(mapPaymentSource('paypal'), 'PAYPAL');
    assert.equal(mapPaymentSource('daraja'), 'DARAJA');
    assert.equal(mapPaymentSource('stripe'), 'STRIPE');
    assert.equal(mapPaymentSource('admin'), 'ADMIN');
  });

  it('computes remaining days from expiry', () => {
    const inTwoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000 + 60_000);
    assert.equal(remainingDaysFrom(inTwoDays), 3);
    assert.equal(remainingDaysFrom(new Date(Date.now() - 1000)), 0);
    assert.equal(remainingDaysFrom(null), null);
  });

  it('applyActiveSubscriptionFields sets ACTIVE lowercase status and paymentSource', () => {
    const user = { subscription: { tier: 'basic', status: 'pending' } };
    applyActiveSubscriptionFields(user, {
      tier: 'professional',
      provider: 'manual_mpesa',
      paymentSource: 'MANUAL_MPESA',
      providerOrderId: 'QH7X2K9M1A',
      billingCycle: 'monthly',
      periodDays: 30,
      activatedBy: 'admin1'
    });
    assert.equal(user.subscription.status, 'active');
    assert.equal(user.subscription.tier, 'professional');
    assert.equal(user.subscription.paymentSource, 'MANUAL_MPESA');
    assert.equal(user.subscription.providerOrderId, 'QH7X2K9M1A');
    assert.ok(user.subscription.current_period_end instanceof Date);
    assert.ok(user.subscription.startDate instanceof Date);

    const serialized = serializeSubscription(user.subscription);
    assert.equal(serialized.expiryDate, user.subscription.current_period_end);
    assert.ok(serialized.remainingDays >= 29);
  });
});

describe('Access gates use subscription ACTIVE only', () => {
  it('denies pending / expired / cancelled and allows active', () => {
    assert.equal(canAccessLiveAlerts({ status: 'pending', tier: 'premium' }), false);
    assert.equal(canAccessLiveAlerts({ status: 'expired', tier: 'premium' }), false);
    assert.equal(canAccessLiveAlerts({ status: 'cancelled', tier: 'premium' }), false);
    assert.equal(canAccessLiveAlerts({ status: 'inactive', tier: 'basic' }), false);
    assert.equal(
      canAccessLiveAlerts({
        status: 'active',
        tier: 'basic',
        current_period_end: new Date(Date.now() + 86400000)
      }),
      true
    );
  });

  it('treats past-due active as inactive for access', () => {
    assert.equal(
      isSubscriptionActive({
        status: 'active',
        current_period_end: new Date(Date.now() - 1000)
      }),
      false
    );
  });

  it('userCanAccessLiveAlerts never requires payment records', () => {
    assert.equal(
      userCanAccessLiveAlerts({
        role: 'user',
        email: 'trader@example.com',
        subscription: { status: 'pending', tier: 'professional' }
      }),
      false
    );
    assert.equal(
      userCanAccessLiveAlerts({
        role: 'user',
        email: 'trader@example.com',
        subscription: {
          status: 'active',
          tier: 'professional',
          current_period_end: new Date(Date.now() + 86400000)
        }
      }),
      true
    );
  });

  it('getEffectiveSubscription surfaces remainingDays / expiryDate aliases', () => {
    const end = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const sub = getEffectiveSubscription({
      role: 'user',
      email: 'a@b.com',
      subscription: {
        status: 'active',
        tier: 'basic',
        startDate: new Date(),
        current_period_end: end,
        paymentSource: 'MANUAL_MPESA'
      }
    });
    assert.equal(sub.status, 'active');
    assert.equal(sub.expiryDate, end);
    assert.equal(sub.paymentSource, 'MANUAL_MPESA');
    assert.ok(sub.remainingDays >= 4);
  });

  it('maps past-due active to expired in effective subscription', () => {
    const sub = getEffectiveSubscription({
      role: 'user',
      email: 'a@b.com',
      subscription: {
        status: 'active',
        tier: 'basic',
        current_period_end: new Date(Date.now() - 60_000)
      }
    });
    assert.equal(sub.status, 'expired');
    assert.equal(sub.remainingDays, 0);
  });
});
