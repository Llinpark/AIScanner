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
const devUserStore = require('../../utils/devUserStore');

function restoreDevStore() {
  if (originalStore == null) {
    if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
  } else {
    fs.writeFileSync(STORE_PATH, originalStore, 'utf8');
  }
}

function seedUser(userId) {
  return devUserStore.upsertUser(userId, {
    email: `${userId}@example.com`,
    subscription: {
      status: 'active',
      tier: 'professional',
      current_period_end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    },
    mt5: { devices: [] }
  });
}

async function pairDevice(userId, fingerprint = 'fp-rel') {
  const { pairCode } = await Mt5PairingService.startPairing(userId);
  const result = await Mt5PairingService.completePairing(
    {
      pairCode,
      terminalId: 'term-rel',
      accountNumber: '9001',
      broker: 'TestBroker',
      terminalBuild: '4000',
      eaVersion: '1.22',
      machineFingerprint: fingerprint
    },
    { ip: '198.51.100.10' }
  );
  assert.equal(result.ok, true);
  return result;
}

describe('MT5 reliability hardening (UUID ack + heartbeat reclaim)', () => {
  const userId = 'mt5-reliability-user';

  beforeEach(() => {
    assert.notEqual(mongoose.connection.readyState, 1);
    Mt5PairingService._clearMemory();
    Mt5TradeCopierService._clearDevExecutions();
    seedUser(userId);
  });

  afterEach(() => {
    Mt5PairingService._clearMemory();
    Mt5TradeCopierService._clearDevExecutions();
    restoreDevStore();
  });

  it('acknowledges report with eventUuid and dedupes repeats', async () => {
    const paired = await pairDevice(userId);
    const execId = 'exec-uuid-1';
    Mt5TradeCopierService._setDevExecution({
      _id: execId,
      userId,
      signalId: 'sig-1',
      symbol: 'EURUSD',
      mt5Symbol: 'EURUSD',
      direction: 'buy',
      entry: 1.1,
      stopLoss: 1.09,
      takeProfit1: 1.12,
      lotSize: 1,
      status: 'sent',
      claimedAt: new Date(),
      managementState: { phase: 'sent', events: [], ackedEventUuids: [] }
    });

    const first = await Mt5TradeCopierService.reportExecution(paired.accessToken, {
      executionId: execId,
      status: 'filled',
      event: 'tp1_hit',
      eventUuid: 'evt-aaa-111',
      ticket: '555',
      remainingVolume: 0.6,
      partialVolume: 0.4,
      partialClosePercent: 40
    });
    assert.equal(first.ok, true);
    assert.equal(first.acknowledged, true);
    assert.equal(first.eventUuid, 'evt-aaa-111');
    assert.equal(first.duplicate, false);
    assert.equal(first.execution.managementState.tp1Hit, true);
    assert.equal(first.execution.managementState.events.length, 1);

    const second = await Mt5TradeCopierService.reportExecution(paired.accessToken, {
      executionId: execId,
      status: 'filled',
      event: 'tp1_hit',
      eventUuid: 'evt-aaa-111',
      ticket: '555',
      remainingVolume: 0.6,
      partialVolume: 0.4
    });
    assert.equal(second.ok, true);
    assert.equal(second.acknowledged, true);
    assert.equal(second.duplicate, true);
    assert.equal(second.execution.managementState.events.length, 1);
  });

  it('does not reclaim sent-without-ticket while claimer heartbeat is alive', async () => {
    const paired = await pairDevice(userId, 'fp-alive');
    const execId = 'exec-reclaim-alive';
    Mt5TradeCopierService._setDevExecution({
      _id: execId,
      userId,
      signalId: 'sig-alive',
      symbol: 'EURUSD',
      mt5Symbol: 'EURUSD',
      direction: 'buy',
      entry: 1.1,
      stopLoss: 1.09,
      takeProfit1: 1.12,
      lotSize: 0.1,
      status: 'sent',
      mt5Ticket: null,
      claimedAt: new Date(Date.now() - 130000),
      claimedByDeviceId: paired.deviceId,
      createdAt: new Date(Date.now() - 140000),
      managementState: { phase: 'sent' }
    });

    await Mt5TradeCopierService.recordDeviceHeartbeat(paired.accessToken, {
      balance: 10000,
      currency: 'USD',
      eaVersion: '1.22'
    });

    const result = await Mt5TradeCopierService.reclaimStaleSentClaims(userId);
    assert.equal(result.reclaimed, 0);
    const row = Mt5TradeCopierService._getDevExecution(execId);
    assert.equal(row.status, 'sent');
  });

  it('reclaims sent-without-ticket when claimer heartbeat is missing', async () => {
    const paired = await pairDevice(userId, 'fp-dead');
    const execId = 'exec-reclaim-dead';

    // Stale heartbeat on device
    const user = devUserStore.findById(userId);
    const devices = (user.mt5.devices || []).map(d =>
      String(d.deviceId) === String(paired.deviceId)
        ? { ...d, lastHeartbeatAt: new Date(Date.now() - 120000) }
        : d
    );
    devUserStore.upsertUser(userId, { mt5: { ...user.mt5, devices } });

    Mt5TradeCopierService._setDevExecution({
      _id: execId,
      userId,
      signalId: 'sig-dead',
      symbol: 'EURUSD',
      mt5Symbol: 'EURUSD',
      direction: 'buy',
      entry: 1.1,
      stopLoss: 1.09,
      takeProfit1: 1.12,
      lotSize: 0.1,
      status: 'sent',
      mt5Ticket: null,
      claimedAt: new Date(Date.now() - 130000),
      claimedByDeviceId: paired.deviceId,
      createdAt: new Date(Date.now() - 140000),
      managementState: { phase: 'sent' }
    });

    const result = await Mt5TradeCopierService.reclaimStaleSentClaims(userId);
    assert.equal(result.reclaimed, 1);
    const row = Mt5TradeCopierService._getDevExecution(execId);
    assert.equal(row.status, 'pending');
    assert.equal(row.claimedByDeviceId, null);
    assert.equal(row.managementState.lastEvent, 'reclaimed');
  });

  it('claims store claimedByDeviceId for heartbeat-aware reclaim', async () => {
    const paired = await pairDevice(userId, 'fp-claim');
    Mt5TradeCopierService._setDevExecution({
      _id: 'exec-claim-1',
      userId,
      signalId: 'sig-claim',
      symbol: 'XAUUSD',
      mt5Symbol: 'XAUUSD',
      direction: 'buy',
      entry: 2000,
      stopLoss: 1990,
      takeProfit1: 2010,
      lotSize: 0.05,
      status: 'pending',
      createdAt: new Date(),
      managementState: { phase: 'queued' }
    });

    const pending = await Mt5TradeCopierService.getPendingExecutions(paired.accessToken);
    assert.equal(pending.ok, true);
    assert.equal(pending.trades.length, 1);
    assert.equal(pending.trades[0].status, 'sent');
    assert.equal(pending.trades[0].claimedByDeviceId, paired.deviceId);
  });
});
