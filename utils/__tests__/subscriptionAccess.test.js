const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getEffectiveSubscription,
  isSubscriptionActive,
  hasFullAccess
} = require('../subscriptionAccess');
const { sanitizeUser } = require('../auth');

describe('getEffectiveSubscription admin bypass', () => {
  it('forces admin/super_admin status to active premium without fake expiry', () => {
    for (const role of ['admin', 'super_admin']) {
      const sub = getEffectiveSubscription({
        email: 'ops@example.com',
        role,
        subscription: { status: 'inactive', tier: 'basic' }
      });
      assert.equal(sub.status, 'active');
      assert.equal(sub.tier, 'premium');
      assert.equal(sub.adminBypass, true);
      assert.equal(sub.unlimitedAccess, true);
      assert.equal(sub.current_period_end, null);
      assert.equal(sub.expiryDate, null);
      assert.equal(sub.remainingDays, null);
      assert.equal(sub.statusLabel, 'Unlimited Access');
      assert.equal(sub.expiresLabel, 'Never');
      assert.equal(isSubscriptionActive(sub), true);
      assert.equal(hasFullAccess({ email: 'ops@example.com', role }), true);
      // Never use a sentinel far-future year for UX.
      assert.ok(!String(sub.current_period_end || '').includes('2099'));
      assert.ok(!String(sub.expiryDate || '').includes('2100'));
    }
  });

  it('labels Super Admin vs Administrator (not paid plan names)', () => {
    const superSub = getEffectiveSubscription({
      email: 'collinspark1985@gmail.com',
      role: 'super_admin',
      subscription: { status: 'inactive' }
    });
    assert.equal(superSub.planLabel, 'Super Admin');

    const adminSub = getEffectiveSubscription({
      email: 'ops@example.com',
      role: 'admin',
      subscription: { status: 'inactive' }
    });
    assert.equal(adminSub.planLabel, 'Administrator');
    assert.notEqual(adminSub.planLabel, 'Premium');
    assert.notEqual(adminSub.planLabel, 'Pro');
    assert.notEqual(adminSub.planLabel, 'Basic');
  });

  it('leaves non-admin inactive subscriptions inactive', () => {
    const sub = getEffectiveSubscription({
      email: 'user@example.com',
      role: 'user',
      subscription: { status: 'inactive', tier: 'basic' }
    });
    assert.equal(sub.status, 'inactive');
    assert.equal(sub.tier, 'basic');
    assert.equal(sub.adminBypass, undefined);
    assert.equal(isSubscriptionActive(sub), false);
  });

  it('preserves active paid subscriber status and real expiry for non-admins', () => {
    const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const sub = getEffectiveSubscription({
      email: 'paid@example.com',
      role: 'user',
      subscription: { status: 'active', tier: 'professional', current_period_end: end }
    });
    assert.equal(sub.status, 'active');
    assert.equal(sub.tier, 'professional');
    assert.equal(sub.expiryDate, end);
    assert.equal(sub.current_period_end, end);
    assert.ok(sub.remainingDays >= 6);
    assert.equal(sub.adminBypass, undefined);
    assert.equal(isSubscriptionActive(sub), true);
  });

  it('sanitizeUser surfaces effective unlimited access for admins', () => {
    const user = sanitizeUser({
      _id: '64b0f0f0f0f0f0f0f0f0f0aa',
      email: 'admin@example.com',
      role: 'admin',
      subscription: { status: 'cancelled', tier: 'basic' },
      createdAt: new Date()
    });
    assert.equal(user.subscription.status, 'active');
    assert.equal(user.subscription.tier, 'premium');
    assert.equal(user.subscription.planLabel, 'Administrator');
    assert.equal(user.subscription.expiresLabel, 'Never');
    assert.equal(user.subscription.current_period_end, null);
    assert.equal(user.isAdmin, true);
  });
});
