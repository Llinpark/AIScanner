/**
 * Mongoose-backed regression tests for MT5 device revoke persistence.
 * Plain-object (devUserStore) tests can falsely pass the subdocument spread bug.
 */
process.env.NODE_ENV = 'test';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const crypto = require('crypto');

const MONGO_URI =
  process.env.MT5_REVOKE_TEST_MONGO_URI ||
  'mongodb://127.0.0.1:27017/kaching_mt5_revoke_persistence_test';

let UserConfig;
let Mt5TradeCopierService;
let revokeDeviceHttpStatus;
let mongoAvailable = false;

function makeDevice(overrides = {}) {
  return {
    deviceId: overrides.deviceId || crypto.randomBytes(12).toString('hex'),
    accessToken: overrides.accessToken === undefined ? crypto.randomBytes(24).toString('hex') : overrides.accessToken,
    refreshToken:
      overrides.refreshToken === undefined ? crypto.randomBytes(32).toString('hex') : overrides.refreshToken,
    accessExpiresAt: overrides.accessExpiresAt || new Date(Date.now() + 86400000),
    refreshExpiresAt: overrides.refreshExpiresAt || new Date(Date.now() + 86400000 * 90),
    friendlyName: overrides.friendlyName || 'MT5 Terminal',
    label: overrides.label || overrides.friendlyName || 'MT5 Terminal',
    broker: overrides.broker || 'EGM Securities Limited',
    accountNumber: overrides.accountNumber || '169878',
    platform: overrides.platform || 'Windows',
    terminalBuild: overrides.terminalBuild || '4000',
    eaVersion: overrides.eaVersion || '1.22',
    machineFingerprint: overrides.machineFingerprint || 'fp-test',
    terminalId: overrides.terminalId || 'term-1',
    firstPairedAt: overrides.firstPairedAt || new Date(),
    lastHeartbeatAt: overrides.lastHeartbeatAt || new Date(),
    lastSeenIP: overrides.lastSeenIP || '203.0.113.10',
    createdAt: overrides.createdAt || new Date(),
    revokedAt: overrides.revokedAt === undefined ? null : overrides.revokedAt
  };
}

async function seedUser(devices, mt5Extras = {}) {
  const email = `revoke-${crypto.randomBytes(6).toString('hex')}@example.com`;
  return UserConfig.create({
    email,
    passwordHash: 'test-hash-not-used',
    subscription: {
      status: 'active',
      tier: 'professional',
      current_period_end: new Date(Date.now() + 7 * 86400000)
    },
    mt5: {
      enabled: true,
      accountBalance: 12500.5,
      accountCurrency: 'USD',
      riskPercent: 1.5,
      fixedLotSize: 0.02,
      symbolSuffix: '.r',
      executionMode: 'manual',
      lastSyncAt: new Date('2026-01-15T12:00:00.000Z'),
      linkedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...mt5Extras,
      devices
    }
  });
}

describe('MT5 device revoke persistence (Mongoose)', () => {
  before(async () => {
    try {
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
      mongoAvailable = mongoose.connection.readyState === 1;
    } catch {
      mongoAvailable = false;
    }
    if (!mongoAvailable) return;

    // Load after connect so isDbConnected() is true inside the service.
    UserConfig = require('../../models/User');
    Mt5TradeCopierService = require('../Mt5TradeCopierService');
    revokeDeviceHttpStatus = require('../../routes/mt5').revokeDeviceHttpStatus;
  });

  after(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase().catch(() => {});
      await mongoose.disconnect().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!mongoAvailable) {
      t.skip('Local MongoDB not available for Mongoose revoke persistence tests');
      return;
    }
    await UserConfig.deleteMany({});
  });

  afterEach(async () => {
    if (!mongoAvailable) return;
    // Restore findByIdAndUpdate if a test stubbed it.
    if (UserConfig.findByIdAndUpdate && UserConfig.findByIdAndUpdate._isRevokeTestStub) {
      UserConfig.findByIdAndUpdate = UserConfig.findByIdAndUpdate._original;
    }
  });

  it('revokes a Mongoose embedded device and persists revokedAt + cleared tokens', async () => {
    const device = makeDevice({
      deviceId: 'dev-a1b2c3d4e5f6',
      broker: 'EGM Securities Limited',
      accountNumber: '169878'
    });
    const user = await seedUser([device]);

    // Ensure we start from a real subdocument path (production shape).
    const loaded = await UserConfig.findById(user._id);
    assert.equal(typeof loaded.mt5.devices[0].toObject, 'function');

    const result = await Mt5TradeCopierService.revokeDevice(user._id.toString(), device.deviceId);
    assert.equal(result.ok, true);
    assert.equal(result.deviceId, device.deviceId);

    const reread = await UserConfig.findById(user._id);
    const stored = reread.mt5.devices.find(d => String(d.deviceId) === device.deviceId);
    assert.ok(stored);
    assert.ok(stored.revokedAt);
    assert.equal(stored.accessToken, null);
    assert.equal(stored.refreshToken, null);

    const listed = await Mt5TradeCopierService.listAuthorizedDevices(user._id.toString());
    assert.equal(listed.some(d => String(d.deviceId) === device.deviceId), false);
  });

  it('preserves other devices when one is revoked', async () => {
    const target = makeDevice({
      deviceId: 'revoke-target-001',
      broker: 'EGM Securities Limited',
      accountNumber: '169878',
      accessToken: 'target-access-token-value',
      refreshToken: 'target-refresh-token-value'
    });
    const other = makeDevice({
      deviceId: 'revoke-keep-002',
      broker: 'Other Broker',
      accountNumber: '999001',
      accessToken: 'other-access-token-value',
      refreshToken: 'other-refresh-token-value',
      friendlyName: 'Keep Me'
    });
    const user = await seedUser([target, other]);

    const result = await Mt5TradeCopierService.revokeDevice(user._id.toString(), target.deviceId);
    assert.equal(result.ok, true);

    const reread = await UserConfig.findById(user._id);
    assert.equal(reread.mt5.devices.length, 2);

    const revoked = reread.mt5.devices.find(d => String(d.deviceId) === target.deviceId);
    const kept = reread.mt5.devices.find(d => String(d.deviceId) === other.deviceId);
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.accessToken, null);
    assert.equal(revoked.refreshToken, null);

    assert.equal(kept.revokedAt, null);
    assert.equal(kept.accessToken, 'other-access-token-value');
    assert.equal(kept.refreshToken, 'other-refresh-token-value');
    assert.equal(kept.broker, 'Other Broker');
    assert.equal(kept.accountNumber, '999001');

    const listed = await Mt5TradeCopierService.listAuthorizedDevices(user._id.toString());
    assert.equal(listed.length, 1);
    assert.equal(listed[0].deviceId, other.deviceId);
  });

  it('returns device_not_found for missing device (404 contract)', async () => {
    const device = makeDevice({ deviceId: 'only-device-xyz' });
    const user = await seedUser([device]);

    const result = await Mt5TradeCopierService.revokeDevice(user._id.toString(), 'does-not-exist');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'device_not_found');
    assert.equal(revokeDeviceHttpStatus(result.reason), 404);

    const listed = await Mt5TradeCopierService.listAuthorizedDevices(user._id.toString());
    assert.equal(listed.length, 1);
    assert.equal(listed[0].deviceId, device.deviceId);
  });

  it('returns persist_failed (HTTP 500) when persistence verification fails', async () => {
    const device = makeDevice({ deviceId: 'verify-fail-device' });
    const user = await seedUser([device]);

    const original = UserConfig.findByIdAndUpdate.bind(UserConfig);
    const stub = async function findByIdAndUpdateNoop(id) {
      // Pretend success but leave the document unchanged (simulates old spread bug).
      return UserConfig.findById(id);
    };
    stub._isRevokeTestStub = true;
    stub._original = original;
    UserConfig.findByIdAndUpdate = stub;

    const result = await Mt5TradeCopierService.revokeDevice(user._id.toString(), device.deviceId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'persist_failed');
    assert.equal(revokeDeviceHttpStatus(result.reason), 500);
    assert.notEqual(revokeDeviceHttpStatus(result.reason), 200);
  });

  it('clears both accessToken and refreshToken after successful revoke', async () => {
    const device = makeDevice({
      deviceId: 'token-clear-device',
      accessToken: 'must-clear-access',
      refreshToken: 'must-clear-refresh'
    });
    const user = await seedUser([device]);

    const result = await Mt5TradeCopierService.revokeDevice(user._id.toString(), device.deviceId);
    assert.equal(result.ok, true);

    const reread = await UserConfig.findById(user._id);
    const stored = reread.mt5.devices.find(d => String(d.deviceId) === device.deviceId);
    assert.equal(stored.accessToken, null);
    assert.equal(stored.refreshToken, null);
    assert.ok(stored.revokedAt);
  });

  it('preserves unrelated MT5 fields when revoking a device', async () => {
    const device = makeDevice({ deviceId: 'preserve-fields-device' });
    const user = await seedUser([device], {
      enabled: true,
      accountBalance: 12500.5,
      accountCurrency: 'USD',
      riskPercent: 1.5,
      fixedLotSize: 0.02,
      symbolSuffix: '.r',
      executionMode: 'manual',
      lastSyncAt: new Date('2026-01-15T12:00:00.000Z')
    });

    const before = await UserConfig.findById(user._id);
    const result = await Mt5TradeCopierService.revokeDevice(user._id.toString(), device.deviceId);
    assert.equal(result.ok, true);

    const after = await UserConfig.findById(user._id);
    assert.equal(after.mt5.enabled, true);
    assert.equal(after.mt5.accountBalance, 12500.5);
    assert.equal(after.mt5.accountCurrency, 'USD');
    assert.equal(after.mt5.riskPercent, 1.5);
    assert.equal(after.mt5.fixedLotSize, 0.02);
    assert.equal(after.mt5.symbolSuffix, '.r');
    assert.equal(after.mt5.executionMode, 'manual');
    assert.equal(
      new Date(after.mt5.lastSyncAt).toISOString(),
      new Date(before.mt5.lastSyncAt).toISOString()
    );
  });

  it('maps revoke HTTP statuses correctly', () => {
    if (!mongoAvailable) return;
    assert.equal(revokeDeviceHttpStatus('device_not_found'), 404);
    assert.equal(revokeDeviceHttpStatus('user_not_found'), 404);
    assert.equal(revokeDeviceHttpStatus('persist_failed'), 500);
  });
});
