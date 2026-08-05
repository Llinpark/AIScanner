process.env.NODE_ENV = 'test';
process.env.MT5_PAIRING_ALLOW_MEMORY = 'true';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const STORE_PATH = path.join(__dirname, '..', '..', 'dev-users.json');
const originalStore = fs.existsSync(STORE_PATH) ? fs.readFileSync(STORE_PATH, 'utf8') : null;

const Mt5PairingService = require('../Mt5PairingService');
const Mt5TradeCopierService = require('../Mt5TradeCopierService');
const { createRateLimiter } = require('../../middleware/rateLimit');
const { getRedisClient } = require('../../utils/redisClient');
const devUserStore = require('../../utils/devUserStore');

function restoreDevStore() {
  if (originalStore == null) {
    if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
  } else {
    fs.writeFileSync(STORE_PATH, originalStore, 'utf8');
  }
}

function seedUser(userId, tier = 'professional') {
  devUserStore.upsertUser(userId, {
    email: `${userId}@example.com`,
    subscription: {
      status: 'active',
      tier,
      current_period_end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    },
    mt5: { devices: [] }
  });
}

describe('MT5 pairing flow (PairCode + devices, memory test mode)', () => {
  const userId = 'mt5-pair-test-user';

  beforeEach(() => {
    assert.notEqual(mongoose.connection.readyState, 1);
    Mt5PairingService._clearMemory();
    seedUser(userId);
  });

  afterEach(() => {
    Mt5PairingService._clearMemory();
    restoreDevStore();
  });

  it('startPairing returns an 8-char alphanumeric code without permanent tokens', async () => {
    const session = await Mt5PairingService.startPairing(userId);
    assert.match(session.pairCode, Mt5PairingService.PAIR_CODE_RE);
    assert.equal(session.pairCode.length, 8);
    assert.ok(session.expiresAt instanceof Date);
    assert.equal('token' in session, false);
    assert.equal('accessToken' in session, false);
    assert.ok(session.storage === 'memory' || session.storage === 'redis');
  });

  it('completePairing issues device-scoped access + refresh tokens', async () => {
    const { pairCode } = await Mt5PairingService.startPairing(userId);
    const result = await Mt5PairingService.completePairing(
      {
        pairCode,
        terminalId: 'build-123',
        accountNumber: '1001',
        broker: 'HFM',
        terminalBuild: '4000',
        eaVersion: '1.14',
        machineFingerprint: 'fp-abc'
      },
      { ip: '203.0.113.10' }
    );

    assert.equal(result.ok, true);
    assert.ok(result.accessToken);
    assert.ok(result.refreshToken);
    assert.ok(result.deviceId);
    assert.equal(result.token, result.accessToken);

    const user = await Mt5TradeCopierService.findUserByMt5Token(result.accessToken);
    assert.ok(user);
    assert.equal(String(user._id || user.id), userId);

    const devices = await Mt5TradeCopierService.listAuthorizedDevices(userId);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].broker, 'HFM');
    assert.equal(devices[0].status, 'Active');
    assert.ok(devices[0].friendlyName);
  });

  it('supports multiple devices and revoke is device-scoped', async () => {
    const a = await Mt5PairingService.startPairing(userId);
    const first = await Mt5PairingService.completePairing(
      { pairCode: a.pairCode, broker: 'Office', accountNumber: '1' },
      { ip: '203.0.113.11' }
    );
    assert.equal(first.ok, true);

    const b = await Mt5PairingService.startPairing(userId);
    const second = await Mt5PairingService.completePairing(
      { pairCode: b.pairCode, broker: 'Laptop', accountNumber: '2' },
      { ip: '203.0.113.12' }
    );
    assert.equal(second.ok, true);
    assert.notEqual(first.deviceId, second.deviceId);
    assert.notEqual(first.accessToken, second.accessToken);

    assert.ok(await Mt5TradeCopierService.findUserByMt5Token(first.accessToken));
    assert.ok(await Mt5TradeCopierService.findUserByMt5Token(second.accessToken));

    await Mt5TradeCopierService.revokeDevice(userId, first.deviceId);

    assert.equal(await Mt5TradeCopierService.findUserByMt5Token(first.accessToken), null);
    assert.ok(await Mt5TradeCopierService.findUserByMt5Token(second.accessToken));

    const devices = await Mt5TradeCopierService.listAuthorizedDevices(userId);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceId, second.deviceId);
  });

  it('refreshAccessToken renews access without affecting other devices', async () => {
    const { pairCode } = await Mt5PairingService.startPairing(userId);
    const paired = await Mt5PairingService.completePairing({ pairCode, broker: 'Home' }, { ip: '1.1.1.1' });
    const refreshed = await Mt5PairingService.refreshAccessToken({
      refreshToken: paired.refreshToken,
      deviceId: paired.deviceId
    });
    assert.equal(refreshed.ok, true);
    assert.ok(refreshed.accessToken);
    assert.notEqual(refreshed.accessToken, paired.accessToken);
    assert.equal(await Mt5TradeCopierService.findUserByMt5Token(paired.accessToken), null);
    assert.ok(await Mt5TradeCopierService.findUserByMt5Token(refreshed.accessToken));
  });

  it('pair codes are one-time use (atomic consume)', async () => {
    const { pairCode } = await Mt5PairingService.startPairing(userId);
    const first = await Mt5PairingService.completePairing({ pairCode }, { ip: '10.0.0.1' });
    assert.equal(first.ok, true);
    const second = await Mt5PairingService.completePairing({ pairCode }, { ip: '10.0.0.1' });
    assert.equal(second.ok, false);
  });

  it('concurrent completePairing allows exactly one winner', async () => {
    const { pairCode } = await Mt5PairingService.startPairing(userId);
    const results = await Promise.all([
      Mt5PairingService.completePairing({ pairCode, broker: 'A' }, { ip: '10.0.0.40' }),
      Mt5PairingService.completePairing({ pairCode, broker: 'B' }, { ip: '10.0.0.41' }),
      Mt5PairingService.completePairing({ pairCode, broker: 'C' }, { ip: '10.0.0.42' })
    ]);
    const wins = results.filter(r => r.ok);
    const losses = results.filter(r => !r.ok);
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 2);
    const devices = await Mt5TradeCopierService.listAuthorizedDevices(userId);
    assert.equal(devices.length, 1);
  });

  it('restores PairCode when device registration fails', async () => {
    const { pairCode } = await Mt5PairingService.startPairing(userId);
    const original = Mt5TradeCopierService.registerPairedDevice;
    Mt5TradeCopierService.registerPairedDevice = async () => {
      throw new Error('forced register failure');
    };
    try {
      const failed = await Mt5PairingService.completePairing({ pairCode }, { ip: '10.0.0.50' });
      assert.equal(failed.ok, false);
      assert.equal(failed.reason, 'register_failed');
    } finally {
      Mt5TradeCopierService.registerPairedDevice = original;
    }
    const retry = await Mt5PairingService.completePairing({ pairCode }, { ip: '10.0.0.51' });
    assert.equal(retry.ok, true);
  });

  it('returns Pair Code Expired when session TTL has passed', async () => {
    const { pairCode } = await Mt5PairingService.startPairing(userId);
    assert.equal(await Mt5PairingService._forceExpireForTests(pairCode), true);
    const result = await Mt5PairingService.completePairing({ pairCode }, { ip: '10.0.0.2' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
    assert.equal(result.message, 'Pair Code Expired');
  });

  it('rejects malformed pair codes', async () => {
    const result = await Mt5PairingService.completePairing({ pairCode: 'ABC' }, { ip: '10.0.0.3' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_code');
  });

  it('regenerating invalidates the previous pending code', async () => {
    const first = await Mt5PairingService.startPairing(userId);
    const second = await Mt5PairingService.startPairing(userId);
    assert.notEqual(first.pairCode, second.pairCode);
    const stale = await Mt5PairingService.completePairing({ pairCode: first.pairCode }, { ip: '10.0.0.4' });
    assert.equal(stale.ok, false);
    const ok = await Mt5PairingService.completePairing({ pairCode: second.pairCode }, { ip: '10.0.0.5' });
    assert.equal(ok.ok, true);
  });

  it('resolveMt5Auth rejects unknown tokens (no LinkToken path)', async () => {
    const resolved = await Mt5TradeCopierService.resolveMt5Auth('deadbeef'.repeat(6));
    assert.equal(resolved.user, null);
    assert.equal(resolved.reason, 'invalid_token');
  });

  it('heartbeat marks device Active and records lastSeenIP', async () => {
    const { pairCode } = await Mt5PairingService.startPairing(userId);
    const paired = await Mt5PairingService.completePairing({ pairCode }, { ip: '10.0.0.60' });
    const hb = await Mt5TradeCopierService.recordDeviceHeartbeat(
      paired.accessToken,
      { broker: 'HFM', accountNumber: '99' },
      { ip: '198.51.100.7' }
    );
    assert.equal(hb.ok, true);
    const devices = await Mt5TradeCopierService.listAuthorizedDevices(userId);
    assert.equal(devices[0].status, 'Active');
    assert.equal(devices[0].lastSeenIP, '198.51.100.7');
  });

  it('locks after 5 failed complete attempts from same IP', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await Mt5PairingService.completePairing({ pairCode: 'AAAAAAAA' }, { ip: '198.51.100.9' });
      assert.equal(r.ok, false);
    }
    const locked = await Mt5PairingService.completePairing({ pairCode: 'BBBBBBBB' }, { ip: '198.51.100.9' });
    assert.equal(locked.ok, false);
    assert.equal(locked.reason, 'rate_limited');
  });

  it('memoryFallbackAllowed is true under test env', () => {
    assert.equal(Mt5PairingService.memoryFallbackAllowed(), true);
  });
});

describe('MT5 pair/complete coarse rate limit', () => {
  it('blocks after max requests in the pairing window', () => {
    const limiter = createRateLimiter({
      windowMs: 10 * 60_000,
      max: 5,
      message: 'Too many pairing attempts'
    });

    const responses = [];
    for (let i = 0; i < 7; i++) {
      const req = { headers: {}, ip: '203.0.113.50', socket: { remoteAddress: '203.0.113.50' } };
      let statusCode = 200;
      const res = {
        setHeader() {},
        status(code) {
          statusCode = code;
          return this;
        },
        json() {
          responses.push(statusCode);
        }
      };
      limiter(req, res, () => {
        responses.push(200);
      });
    }

    assert.deepEqual(responses, [200, 200, 200, 200, 200, 429, 429]);
  });
});

describe('MT5 pairing Redis integration (skipped when Redis down)', () => {
  const userId = 'mt5-pair-redis-user';
  let redis = null;

  beforeEach(async () => {
    redis = await getRedisClient();
    Mt5PairingService._clearMemory();
    if (redis) seedUser(userId);
  });

  afterEach(async () => {
    Mt5PairingService._clearMemory();
    restoreDevStore();
  });

  it('stores and atomically consumes PairCode via Redis GETDEL when available', async (t) => {
    if (!redis) {
      t.skip('Redis not available in this environment');
      return;
    }

    // Force Redis path: temporarily disallow memory for this assertion by using
    // the real Redis client through the normal store when Redis is up.
    // With ALLOW_MEMORY=true the service still prefers Redis when connected.
    const session = await Mt5PairingService.startPairing(userId);
    assert.equal(session.storage, 'redis');

    const key = `kaching:mt5:pair:code:${session.pairCode}`;
    const raw = await redis.get(key);
    assert.ok(raw);

    const first = await Mt5PairingService.completePairing(
      { pairCode: session.pairCode, broker: 'RedisBroker' },
      { ip: '203.0.113.80' }
    );
    assert.equal(first.ok, true);
    assert.equal(await redis.get(key), null);

    const second = await Mt5PairingService.completePairing(
      { pairCode: session.pairCode },
      { ip: '203.0.113.81' }
    );
    assert.equal(second.ok, false);
  });

  it('concurrent Redis completePairing yields a single winner', async (t) => {
    if (!redis) {
      t.skip('Redis not available in this environment');
      return;
    }

    const session = await Mt5PairingService.startPairing(userId);
    assert.equal(session.storage, 'redis');

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        Mt5PairingService.completePairing(
          { pairCode: session.pairCode, broker: `R${i}` },
          { ip: `203.0.113.${90 + i}` }
        )
      )
    );
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal((await Mt5TradeCopierService.listAuthorizedDevices(userId)).length, 1);
  });
});
