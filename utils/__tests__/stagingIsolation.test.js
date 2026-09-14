'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const iso = require('../../scripts/lib/stagingIsolation');

describe('staging isolation fail-closed guards', () => {
  const keys = [
    'NODE_ENV',
    'FLY_APP',
    'FLY_APP_NAME',
    'STAGING_CONFIRM_ISOLATED',
    'STAGING_MONGO_SOAK',
    'STAGING_TELEGRAM_ENABLED',
    'STAGING_EMAIL_ENABLED',
    'PUBLIC_BACKEND_URL',
    'MONGODB_URI',
    'REDIS_URL',
    'TELEGRAM_BOT_TOKEN',
    'STAGING_TELEGRAM_CHAT_ID',
    'STAGING_TELEGRAM_DENY_CHAT_IDS',
    'SMTP2GO_API_KEY',
    'EMAIL_FROM',
    'STAGING_EMAIL_TO',
    'STAGING_EMAIL_DENY_RECIPIENTS',
    'STAGING_PRODUCTION_HOSTS',
    'WEBHOOK_SIGNING_SECRET',
    'TRADINGVIEW_WEBHOOK_SECRET',
    'LOCAL_INTEGRATION_CANARY',
    'LOCAL_INTEGRATION_CONFIRM_ISOLATED',
    'LOCAL_INTEGRATION_TELEGRAM_ENABLED',
    'LOCAL_INTEGRATION_EMAIL_ENABLED'
  ];
  const saved = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function fillIsolatedStaging() {
    process.env.NODE_ENV = 'staging';
    process.env.STAGING_CONFIRM_ISOLATED = 'true';
    process.env.STAGING_MONGO_SOAK = 'true';
    process.env.STAGING_TELEGRAM_ENABLED = 'true';
    process.env.STAGING_EMAIL_ENABLED = 'true';
    process.env.PUBLIC_BACKEND_URL = 'https://kaching-api-staging.example.test';
    process.env.MONGODB_URI = 'mongodb://staging-mongo.example.test:27017/kaching_staging';
    process.env.REDIS_URL = 'redis://staging-redis.example.test:6379';
    process.env.TELEGRAM_BOT_TOKEN = '123456789:AA-staging-test-token-not-realxx';
    process.env.STAGING_TELEGRAM_CHAT_ID = '999001';
    process.env.SMTP2GO_API_KEY = 'smtp2go-staging-isolated-key-not-production';
    process.env.EMAIL_FROM = 'staging@example.com';
    process.env.STAGING_EMAIL_TO = 'canary@example.com';
    process.env.WEBHOOK_SIGNING_SECRET = 'staging-only-signing-secret-32chars';
    process.env.TRADINGVIEW_WEBHOOK_SECRET = 'staging-only-tv-secret-32charsxxxx';
  }

  it('blocks production Mongo database names and hosts', () => {
    const prodDb = iso.isProductionMongo('mongodb://127.0.0.1:27017/kachingscanner');
    assert.equal(prodDb.blocked, true);
    const prodHost = iso.isProductionMongo('mongodb+srv://u:p@api.kachingscanner.com/kaching_staging');
    assert.equal(prodHost.blocked, true);
    const ok = iso.isProductionMongo('mongodb://127.0.0.1:27017/kaching_staging');
    assert.equal(ok.blocked, false);
    assert.equal(ok.dbName, 'kaching_staging');
  });

  it('blocks production Redis / API hosts', () => {
    assert.equal(iso.isProductionHost('api.kachingscanner.com'), true);
    assert.equal(iso.isProductionHost('kaching-api.fly.dev'), true);
    assert.equal(iso.isProductionRedis('rediss://default:x@kaching-api.fly.dev:6379').blocked, true);
    assert.equal(iso.isProductionRedis('redis://127.0.0.1:6379').blocked, false);
  });

  it('blocks denylisted Telegram chats and production-looking email', () => {
    process.env.STAGING_TELEGRAM_DENY_CHAT_IDS = '111,222';
    assert.equal(iso.isDeniedTelegramChat('111').blocked, true);
    assert.equal(iso.isDeniedTelegramChat('999').blocked, false);
    process.env.STAGING_EMAIL_DENY_RECIPIENTS = 'user@example.com';
    assert.equal(iso.isDeniedEmailRecipient('user@example.com').blocked, true);
    assert.equal(iso.isDeniedEmailRecipient('alice@kachingscanner.com').blocked, true);
    assert.equal(iso.isDeniedEmailRecipient('staging-canary@kachingscanner.com').blocked, false);
    assert.equal(iso.isDeniedEmailRecipient('canary@example.com').blocked, false);
  });

  it('evaluateIsolation fails closed without confirmation flags', () => {
    const r = iso.evaluateIsolation();
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some(b => /STAGING_CONFIRM_ISOLATED/.test(b)));
    assert.ok(r.blockers.some(b => /STAGING_MONGO_SOAK/.test(b)));
    assert.ok(r.blockers.some(b => /STAGING_TELEGRAM_ENABLED/.test(b)));
    assert.ok(r.blockers.some(b => /STAGING_EMAIL_ENABLED/.test(b)));
    assert.ok(r.blockers.some(b => /NODE_ENV must be staging/.test(b)));
  });

  it('evaluateIsolation passes only with isolated non-loopback staging config', () => {
    fillIsolatedStaging();
    const r = iso.evaluateIsolation();
    assert.equal(r.ok, true, r.blockers.join('; '));
    assert.equal(r.loopbackDataPlane, false);
  });

  it('evaluateIsolation rejects production API URL even with flags set', () => {
    fillIsolatedStaging();
    process.env.PUBLIC_BACKEND_URL = 'https://api.kachingscanner.com';
    const r = iso.evaluateIsolation();
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some(b => /production/i.test(b)));
  });

  it('evaluateIsolation rejects NODE_ENV=production and smoke webhook secrets', () => {
    fillIsolatedStaging();
    process.env.NODE_ENV = 'production';
    process.env.WEBHOOK_SIGNING_SECRET = 'smoke-test-license-signing-secret';
    const r = iso.evaluateIsolation();
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some(b => /NODE_ENV=production/.test(b)));
    assert.ok(r.blockers.some(b => /WEBHOOK_SIGNING_SECRET/.test(b)));
  });

  it('evaluateIsolation rejects FLY_APP=kaching-api', () => {
    fillIsolatedStaging();
    process.env.FLY_APP = 'kaching-api';
    const r = iso.evaluateIsolation();
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some(b => /kaching-api is production/.test(b)));
  });

  it('fly.staging.toml targets kaching-api-staging only', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../../fly.staging.toml'), 'utf8');
    const appLine = src
      .split(/\r?\n/)
      .map(l => l.trim())
      .find(l => l && !l.startsWith('#') && /^app\s*=/.test(l));
    assert.equal(appLine, 'app = "kaching-api-staging"');
    assert.match(src, /NODE_ENV\s*=\s*["']staging["']/);
    assert.match(src, /\/api\/health/);
    assert.doesNotMatch(src, /kachingscanner\.com/);
  });

  it('marks loopback URLs so health/canary can refuse real-staging proof', () => {
    fillIsolatedStaging();
    process.env.PUBLIC_BACKEND_URL = 'http://127.0.0.1:4010';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27018/kaching_staging';
    process.env.REDIS_URL = 'redis://127.0.0.1:6380';
    const r = iso.evaluateIsolation();
    assert.equal(r.ok, true, r.blockers.join('; '));
    assert.equal(r.loopbackDataPlane, true);
  });

  function fillLocalIntegration() {
    process.env.NODE_ENV = 'development';
    process.env.LOCAL_INTEGRATION_CANARY = 'true';
    process.env.LOCAL_INTEGRATION_CONFIRM_ISOLATED = 'true';
    process.env.PUBLIC_BACKEND_URL = 'http://127.0.0.1:4010';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/kaching_local_canary';
    process.env.REDIS_URL = 'redis://127.0.0.1:6379';
    process.env.WEBHOOK_SIGNING_SECRET = 'local-canary-signing-secret-32ch';
    process.env.TRADINGVIEW_WEBHOOK_SECRET = 'local-canary-tv-secret-32charsxx';
  }

  it('evaluateLocalIntegration allows confirmed localhost kaching_local_canary', () => {
    fillLocalIntegration();
    const r = iso.evaluateLocalIntegration();
    assert.equal(r.ok, true, r.blockers.join('; '));
    assert.equal(r.mode, 'LOCAL_INTEGRATION');
  });

  it('evaluateLocalIntegration rejects production hosts and production db names', () => {
    fillLocalIntegration();
    process.env.PUBLIC_BACKEND_URL = 'https://api.kachingscanner.com';
    const r = iso.evaluateLocalIntegration();
    assert.equal(r.ok, false);
    process.env.PUBLIC_BACKEND_URL = 'http://127.0.0.1:4010';
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/kachingscanner';
    const r2 = iso.evaluateLocalIntegration();
    assert.equal(r2.ok, false);
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/kaching_staging';
    const r3 = iso.evaluateLocalIntegration();
    assert.equal(r3.ok, false);
  });

  it('evaluateLocalIntegration rejects missing confirmation flags', () => {
    fillLocalIntegration();
    delete process.env.LOCAL_INTEGRATION_CONFIRM_ISOLATED;
    const r = iso.evaluateLocalIntegration();
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some(b => /LOCAL_INTEGRATION_CONFIRM_ISOLATED/.test(b)));
  });

  it('cloud evaluateIsolation still rejects using local canary as staging', () => {
    fillLocalIntegration();
    const cloud = iso.evaluateIsolation();
    assert.equal(cloud.ok, false);
  });
});
