const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  isSuperAdmin,
  isAdmin,
  canManageScannerConfig,
  parseSuperAdminEmails,
  DEFAULT_SUPER_ADMIN_EMAIL
} = require('../adminAccess');

describe('adminAccess', () => {
  const prevSuper = process.env.SUPER_ADMIN_EMAILS;
  const prevAdmin = process.env.ADMIN_EMAILS;

  afterEach(() => {
    if (prevSuper === undefined) delete process.env.SUPER_ADMIN_EMAILS;
    else process.env.SUPER_ADMIN_EMAILS = prevSuper;
    if (prevAdmin === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = prevAdmin;
  });

  it('defaults SUPER_ADMIN_EMAILS to the canonical email', () => {
    delete process.env.SUPER_ADMIN_EMAILS;
    assert.deepEqual(parseSuperAdminEmails(), [DEFAULT_SUPER_ADMIN_EMAIL]);
  });

  it('grants super_admin only to allowlisted emails, not by role alone', () => {
    delete process.env.SUPER_ADMIN_EMAILS;
    assert.equal(
      isSuperAdmin({ email: 'barasajohn1985@gmail.com', role: 'super_admin' }),
      false
    );
    assert.equal(isSuperAdmin({ email: DEFAULT_SUPER_ADMIN_EMAIL, role: 'user' }), true);
    assert.equal(canManageScannerConfig({ email: DEFAULT_SUPER_ADMIN_EMAIL }), true);
    assert.equal(
      canManageScannerConfig({ email: 'other@example.com', role: 'super_admin' }),
      false
    );
  });

  it('keeps general admin for demoted former super_admins', () => {
    delete process.env.SUPER_ADMIN_EMAILS;
    assert.equal(isAdmin({ email: 'barasajohn1985@gmail.com', role: 'super_admin' }), true);
    assert.equal(isAdmin({ email: 'lilianmonari15@gmail.com', role: 'admin' }), true);
    assert.equal(isAdmin({ email: 'user@example.com', role: 'user' }), false);
  });

  it('respects explicit SUPER_ADMIN_EMAILS allowlist', () => {
    process.env.SUPER_ADMIN_EMAILS = 'solo@example.com';
    assert.equal(isSuperAdmin({ email: 'solo@example.com', role: 'user' }), true);
    assert.equal(
      isSuperAdmin({ email: DEFAULT_SUPER_ADMIN_EMAIL, role: 'super_admin' }),
      false
    );
  });
});
