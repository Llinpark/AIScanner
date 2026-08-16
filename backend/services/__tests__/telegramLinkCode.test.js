const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const STORE_PATH = path.join(__dirname, '..', '..', 'dev-users.json');
const originalStore = fs.existsSync(STORE_PATH) ? fs.readFileSync(STORE_PATH, 'utf8') : null;

const TelegramService = require('../TelegramService');
const devUserStore = require('../../utils/devUserStore');

describe('Telegram link code redemption', () => {
  const userId = 'telegram-link-test-user';

  beforeEach(() => {
    // Ensure we exercise the in-memory/dev store path, not Mongo.
    assert.notEqual(mongoose.connection.readyState, 1);
    TelegramService._clearLinkCodeIndex();
    devUserStore.upsertUser(userId, {
      email: 'telegram-link@example.com',
      subscription: {
        status: 'active',
        tier: 'professional',
        current_period_end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      },
      telegram: {}
    });
  });

  afterEach(() => {
    TelegramService._clearLinkCodeIndex();
    if (originalStore == null) {
      if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
    } else {
      fs.writeFileSync(STORE_PATH, originalStore, 'utf8');
    }
  });

  it('resolves codes from DB after the in-memory index is cleared (restart / multi-instance)', async () => {
    const { code } = await TelegramService.createLinkCode(userId);
    TelegramService._clearLinkCodeIndex();

    const resolved = await TelegramService._resolveLinkCode(code);
    assert.ok(resolved);
    assert.equal(resolved.userId, userId);
    assert.equal(resolved.source, 'db');
  });

  it('links a Pro user even when memory was cleared', async () => {
    const { code } = await TelegramService.createLinkCode(userId);
    TelegramService._clearLinkCodeIndex();

    const result = await TelegramService.linkByCode(code, 'chat-123', 'trader');
    assert.equal(result.ok, true);
    assert.equal(result.email, 'telegram-link@example.com');

    const user = devUserStore.findById(userId);
    assert.equal(String(user.telegram.chatId), 'chat-123');
    assert.equal(user.telegram.linkCode, null);
  });

  it('preserves telegramMode alerts_only when linking (no MT5 wipe)', async () => {
    devUserStore.upsertUser(userId, {
      email: 'telegram-link@example.com',
      subscription: {
        status: 'active',
        tier: 'professional',
        current_period_end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      },
      telegram: { telegramMode: 'alerts_only', enabled: true }
    });

    const { code } = await TelegramService.createLinkCode(userId);
    const result = await TelegramService.linkByCode(code, 'chat-alerts-only', 'alertsuser');
    assert.equal(result.ok, true);

    const user = devUserStore.findById(userId);
    assert.equal(String(user.telegram.chatId), 'chat-alerts-only');
    assert.equal(user.telegram.telegramMode, 'alerts_only');
    assert.equal(user.telegram.enabled, true);
  });

  it('rejects Basic users with subscription_required and keeps the code', async () => {
    devUserStore.upsertUser(userId, {
      email: 'telegram-link@example.com',
      subscription: { status: 'active', tier: 'basic' },
      telegram: {}
    });

    const { code } = await TelegramService.createLinkCode(userId);
    const result = await TelegramService.linkByCode(code, 'chat-456', 'basicuser');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'subscription_required');

    // Code should still resolve so they can retry after upgrading.
    const resolved = await TelegramService._resolveLinkCode(code);
    assert.ok(resolved);
  });

  it('returns invalid_or_expired_code for unknown codes', async () => {
    const result = await TelegramService.linkByCode('DEADBEEF', 'chat-789', 'nobody');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_or_expired_code');
  });
});
