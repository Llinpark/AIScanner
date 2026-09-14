'use strict';

/**
 * Fail-closed isolation guards for staging preflight / health / canary.
 * Never prints secret values. Never FLUSHALL. Never fly deploy.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..', '..');

const REQUIRED_STAGING_DB = 'kaching_staging';
const REQUIRED_LOCAL_CANARY_DB = 'kaching_local_canary';

const PRODUCTION_HOST_RE =
  /(^|\.)kachingscanner\.com$|(^|\.)kaching-api\.fly\.dev$|^kaching-api$/i;

const PRODUCTION_MONGO_DB_RE = /^(kachingscanner|kaching|production|prod)$/i;

function truthy(name) {
  return String(process.env[name] || '')
    .trim()
    .toLowerCase() === 'true';
}

function present(name) {
  const v = process.env[name];
  return v != null && String(v).trim() !== '';
}

function loadEnvFromFile(relName) {
  const abs = path.join(ROOT, relName);
  if (!fs.existsSync(abs)) return { exists: false, keys: [], overwritten: [], file: relName };
  const text = fs.readFileSync(abs, 'utf8');
  const keys = [];
  const overwritten = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    keys.push(key);
    const prev = process.env[key];
    if (prev != null && String(prev) !== '' && String(prev) !== val) overwritten.push(key);
    process.env[key] = val;
  }
  return { exists: true, keys, overwritten, file: relName };
}

function loadEnvStaging() {
  return loadEnvFromFile('.env.staging');
}

function loadEnvLocalCanary() {
  return loadEnvFromFile('.env.local-canary');
}

function parseMongoUri(raw) {
  const s = String(raw || '').trim();
  if (!s) return { host: '', dbName: '', ok: false };
  try {
    const normalized = s.replace(/^mongodb\+srv:/i, 'https:').replace(/^mongodb:/i, 'http:');
    const u = new URL(normalized);
    const dbName = decodeURIComponent((u.pathname || '').replace(/^\//, '').split('?')[0] || '');
    return { host: u.hostname || '', dbName, ok: true };
  } catch {
    const m = s.match(/@([^/]+)\/([^?]+)/);
    if (m) return { host: m[1].split(',')[0], dbName: m[2], ok: true };
    return { host: '', dbName: '', ok: false };
  }
}

function parseRedisUri(raw) {
  const s = String(raw || '').trim();
  if (!s) return { host: '', ok: false };
  try {
    const u = new URL(s);
    return { host: u.hostname || '', ok: true };
  } catch {
    return { host: '', ok: false };
  }
}

function parseHttpHost(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    return new URL(s).hostname || '';
  } catch {
    return '';
  }
}

function csvSet(name) {
  return new Set(
    String(process.env[name] || '')
      .split(',')
      .map(x => x.trim().toLowerCase())
      .filter(Boolean)
  );
}

function extraHostDenylist() {
  return csvSet('STAGING_PRODUCTION_HOSTS');
}

function isLoopbackHost(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

function isPlaceholderSecret(raw) {
  const s = String(raw || '').trim();
  if (!s) return true;
  if (s.length < 24) return true;
  return /smoke-test|smoke-optiona|localhost-dev-signing|replace_with_|your_webhook_signing|changeme|example-secret/i.test(
    s
  );
}

function isTelegramBotTokenShape(raw) {
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(raw || '').trim());
}

function productionFlyAppName() {
  const app = String(process.env.FLY_APP || process.env.FLY_APP_NAME || '')
    .trim()
    .toLowerCase();
  return app === 'kaching-api';
}

function isProductionHost(host) {
  const h = String(host || '')
    .trim()
    .toLowerCase();
  if (!h) return false;
  if (PRODUCTION_HOST_RE.test(h)) return true;
  if (extraHostDenylist().has(h)) return true;
  if (/upstash\.io$/i.test(h) && !/staging/i.test(h) && truthy('STAGING_TREAT_UPSTASH_AS_PRODUCTION')) {
    return true;
  }
  return false;
}

function isProductionMongo(uri) {
  const parsed = parseMongoUri(uri);
  if (!parsed.ok) return { blocked: true, reason: 'mongodb_uri_unparseable' };
  if (isProductionHost(parsed.host)) {
    return { blocked: true, reason: 'mongodb_host_production_like' };
  }
  const db = String(parsed.dbName || '').trim();
  if (!db) return { blocked: true, reason: 'mongodb_database_name_missing' };
  if (PRODUCTION_MONGO_DB_RE.test(db) || db !== REQUIRED_STAGING_DB) {
    return { blocked: true, reason: `mongodb_database_must_be_${REQUIRED_STAGING_DB}` };
  }
  return { blocked: false, reason: null, host: parsed.host, dbName: db };
}

function isLocalCanaryMongo(uri) {
  const parsed = parseMongoUri(uri);
  if (!parsed.ok) return { blocked: true, reason: 'mongodb_uri_unparseable' };
  if (isProductionHost(parsed.host)) {
    return { blocked: true, reason: 'mongodb_host_production_like' };
  }
  if (!isLoopbackHost(parsed.host)) {
    return { blocked: true, reason: 'local_canary_mongo_host_must_be_loopback' };
  }
  const db = String(parsed.dbName || '').trim();
  if (!db) return { blocked: true, reason: 'mongodb_database_name_missing' };
  if (PRODUCTION_MONGO_DB_RE.test(db) || db === REQUIRED_STAGING_DB) {
    return { blocked: true, reason: 'mongodb_database_not_allowed_for_local_canary' };
  }
  if (db !== REQUIRED_LOCAL_CANARY_DB) {
    return { blocked: true, reason: `mongodb_database_must_be_${REQUIRED_LOCAL_CANARY_DB}` };
  }
  return { blocked: false, reason: null, host: parsed.host, dbName: db };
}

function isLocalCanaryRedis(uri) {
  const parsed = parseRedisUri(uri);
  if (!parsed.ok) return { blocked: true, reason: 'redis_url_unparseable' };
  if (isProductionHost(parsed.host)) {
    return { blocked: true, reason: 'redis_host_production_like' };
  }
  if (!isLoopbackHost(parsed.host)) {
    return { blocked: true, reason: 'local_canary_redis_host_must_be_loopback' };
  }
  return { blocked: false, reason: null, host: parsed.host };
}

function isProductionRedis(uri) {
  const parsed = parseRedisUri(uri);
  if (!parsed.ok) return { blocked: true, reason: 'redis_url_unparseable' };
  if (isProductionHost(parsed.host)) {
    return { blocked: true, reason: 'redis_host_production_like' };
  }
  return { blocked: false, reason: null, host: parsed.host };
}

function isDeniedTelegramChat(chatId) {
  const id = String(chatId || '').trim();
  if (!id) return { blocked: true, reason: 'staging_telegram_chat_missing' };
  const deny = csvSet('STAGING_TELEGRAM_DENY_CHAT_IDS');
  if (deny.has(id.toLowerCase())) return { blocked: true, reason: 'telegram_chat_on_production_denylist' };
  return { blocked: false, reason: null };
}

function isDeniedEmailRecipient(email) {
  const addr = String(email || '')
    .trim()
    .toLowerCase();
  if (!addr) return { blocked: true, reason: 'staging_email_to_missing' };
  const deny = csvSet('STAGING_EMAIL_DENY_RECIPIENTS');
  if (deny.has(addr)) return { blocked: true, reason: 'email_recipient_on_production_denylist' };
  const at = addr.lastIndexOf('@');
  const domain = at >= 0 ? addr.slice(at + 1) : '';
  const local = at >= 0 ? addr.slice(0, at) : addr;
  if (domain === 'kachingscanner.com' && !/staging|canary|soak|test/.test(local)) {
    return { blocked: true, reason: 'email_recipient_looks_like_production_subscriber' };
  }
  return { blocked: false, reason: null };
}

function probePort(host, port, timeoutMs = 700) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = ok => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

function redactHost(raw) {
  if (!raw) return 'missing';
  try {
    const u = new URL(String(raw).replace(/^mongodb\+srv/i, 'https:').replace(/^mongodb:/i, 'http:'));
    return u.hostname || 'configured';
  } catch {
    return 'configured';
  }
}

/**
 * Fail-closed evaluation. Does not connect to providers.
 */
function evaluateIsolation() {
  const blockers = [];
  const flags = {
    STAGING_CONFIRM_ISOLATED: truthy('STAGING_CONFIRM_ISOLATED'),
    STAGING_MONGO_SOAK: truthy('STAGING_MONGO_SOAK'),
    STAGING_TELEGRAM_ENABLED: truthy('STAGING_TELEGRAM_ENABLED'),
    STAGING_EMAIL_ENABLED: truthy('STAGING_EMAIL_ENABLED')
  };

  if (!flags.STAGING_CONFIRM_ISOLATED) {
    blockers.push('STAGING_CONFIRM_ISOLATED=true is required');
  }

  const nodeEnv = String(process.env.NODE_ENV || '')
    .trim()
    .toLowerCase();
  if (nodeEnv === 'production') {
    blockers.push('NODE_ENV=production is forbidden for staging scripts');
  } else if (nodeEnv !== 'staging') {
    blockers.push('NODE_ENV must be staging');
  }

  if (productionFlyAppName()) {
    blockers.push('FLY_APP=kaching-api is production and cannot be used as staging');
  }

  if (!present('WEBHOOK_SIGNING_SECRET') || isPlaceholderSecret(process.env.WEBHOOK_SIGNING_SECRET)) {
    blockers.push('WEBHOOK_SIGNING_SECRET missing or is a smoke/placeholder value');
  }
  if (
    !present('TRADINGVIEW_WEBHOOK_SECRET') ||
    isPlaceholderSecret(process.env.TRADINGVIEW_WEBHOOK_SECRET)
  ) {
    blockers.push('TRADINGVIEW_WEBHOOK_SECRET missing or is a smoke/placeholder value');
  }

  const apiHost = parseHttpHost(process.env.PUBLIC_BACKEND_URL);
  if (!present('PUBLIC_BACKEND_URL')) blockers.push('PUBLIC_BACKEND_URL missing');
  if (apiHost && isProductionHost(apiHost)) {
    blockers.push('PUBLIC_BACKEND_URL host looks like production');
  }

  const mongo = isProductionMongo(process.env.MONGODB_URI);
  if (!present('MONGODB_URI')) blockers.push('MONGODB_URI missing');
  else if (mongo.blocked) blockers.push(`Mongo isolation: ${mongo.reason}`);
  if (!flags.STAGING_MONGO_SOAK) blockers.push('STAGING_MONGO_SOAK=true is required');

  const redis = isProductionRedis(process.env.REDIS_URL);
  if (!present('REDIS_URL')) blockers.push('REDIS_URL missing');
  else if (redis.blocked) blockers.push(`Redis isolation: ${redis.reason}`);

  if (!present('TELEGRAM_BOT_TOKEN')) blockers.push('TELEGRAM_BOT_TOKEN missing');
  else if (!isTelegramBotTokenShape(process.env.TELEGRAM_BOT_TOKEN)) {
    blockers.push('TELEGRAM_BOT_TOKEN is not a bot-token shape (refusing placeholders)');
  }
  const tgChat = isDeniedTelegramChat(process.env.STAGING_TELEGRAM_CHAT_ID);
  if (tgChat.blocked) blockers.push(`Telegram isolation: ${tgChat.reason}`);
  if (!flags.STAGING_TELEGRAM_ENABLED) blockers.push('STAGING_TELEGRAM_ENABLED=true is required');

  const emailTo = isDeniedEmailRecipient(process.env.STAGING_EMAIL_TO);
  if (!present('SMTP2GO_API_KEY')) {
    blockers.push('SMTP2GO_API_KEY missing (SMTP2GO is the email provider)');
  }
  if (!present('EMAIL_FROM')) {
    blockers.push('EMAIL_FROM missing');
  }
  if (emailTo.blocked) blockers.push(`Email isolation: ${emailTo.reason}`);
  if (!flags.STAGING_EMAIL_ENABLED) blockers.push('STAGING_EMAIL_ENABLED=true is required');

  const webhookHost = parseHttpHost(
    process.env.WEBHOOK_TRADINGVIEW_URL ||
      (process.env.PUBLIC_BACKEND_URL
        ? `${String(process.env.PUBLIC_BACKEND_URL).replace(/\/$/, '')}/api/webhook/tradingview`
        : '')
  );
  if (webhookHost && isProductionHost(webhookHost)) {
    blockers.push('TradingView webhook host looks like production');
  }

  return {
    ok: blockers.length === 0,
    blockers,
    flags,
    mongo: { ...mongo, hostRedacted: redactHost(process.env.MONGODB_URI) },
    redis: { ...redis, hostRedacted: redactHost(process.env.REDIS_URL) },
    apiHostRedacted: apiHost || 'missing',
    loopbackDataPlane:
      isLoopbackHost(apiHost) ||
      isLoopbackHost(mongo.host) ||
      isLoopbackHost(redis.host)
  };
}

/**
 * LOCAL REAL-INTEGRATION mode. Does not replace cloud staging isolation.
 * Loopback is allowed only here, and only with kaching_local_canary + confirmation flags.
 */
function evaluateLocalIntegration() {
  const blockers = [];
  const flags = {
    LOCAL_INTEGRATION_CANARY: truthy('LOCAL_INTEGRATION_CANARY'),
    LOCAL_INTEGRATION_CONFIRM_ISOLATED: truthy('LOCAL_INTEGRATION_CONFIRM_ISOLATED'),
    LOCAL_INTEGRATION_TELEGRAM_ENABLED: truthy('LOCAL_INTEGRATION_TELEGRAM_ENABLED'),
    LOCAL_INTEGRATION_EMAIL_ENABLED: truthy('LOCAL_INTEGRATION_EMAIL_ENABLED')
  };

  if (!flags.LOCAL_INTEGRATION_CANARY) {
    blockers.push('LOCAL_INTEGRATION_CANARY=true is required');
  }
  if (!flags.LOCAL_INTEGRATION_CONFIRM_ISOLATED) {
    blockers.push('LOCAL_INTEGRATION_CONFIRM_ISOLATED=true is required');
  }

  const nodeEnv = String(process.env.NODE_ENV || '')
    .trim()
    .toLowerCase();
  if (nodeEnv === 'production') {
    blockers.push('NODE_ENV=production is forbidden for local integration canary');
  } else if (nodeEnv !== 'development') {
    blockers.push('NODE_ENV must be development for local integration canary');
  }

  if (productionFlyAppName()) {
    blockers.push('FLY_APP=kaching-api is production and cannot be used as local canary');
  }

  if (!present('WEBHOOK_SIGNING_SECRET') || isPlaceholderSecret(process.env.WEBHOOK_SIGNING_SECRET)) {
    blockers.push('WEBHOOK_SIGNING_SECRET missing or is a smoke/placeholder value');
  }
  if (
    !present('TRADINGVIEW_WEBHOOK_SECRET') ||
    isPlaceholderSecret(process.env.TRADINGVIEW_WEBHOOK_SECRET)
  ) {
    blockers.push('TRADINGVIEW_WEBHOOK_SECRET missing or is a smoke/placeholder value');
  }

  const apiHost = parseHttpHost(process.env.PUBLIC_BACKEND_URL);
  if (!present('PUBLIC_BACKEND_URL')) blockers.push('PUBLIC_BACKEND_URL missing');
  if (apiHost && isProductionHost(apiHost)) {
    blockers.push('PUBLIC_BACKEND_URL host looks like production');
  }
  if (apiHost && !isLoopbackHost(apiHost)) {
    blockers.push('local canary PUBLIC_BACKEND_URL must be localhost');
  }

  const mongo = isLocalCanaryMongo(process.env.MONGODB_URI);
  if (!present('MONGODB_URI')) blockers.push('MONGODB_URI missing');
  else if (mongo.blocked) blockers.push(`Mongo isolation: ${mongo.reason}`);

  const redis = isLocalCanaryRedis(process.env.REDIS_URL);
  if (!present('REDIS_URL')) blockers.push('REDIS_URL missing');
  else if (redis.blocked) blockers.push(`Redis isolation: ${redis.reason}`);

  if (flags.LOCAL_INTEGRATION_TELEGRAM_ENABLED) {
    if (!present('TELEGRAM_BOT_TOKEN')) blockers.push('TELEGRAM_BOT_TOKEN missing');
    else if (!isTelegramBotTokenShape(process.env.TELEGRAM_BOT_TOKEN)) {
      blockers.push('TELEGRAM_BOT_TOKEN is not a bot-token shape (refusing placeholders)');
    }
    const tgChat = isDeniedTelegramChat(process.env.STAGING_TELEGRAM_CHAT_ID);
    if (tgChat.blocked) blockers.push(`Telegram isolation: ${tgChat.reason}`);
  }

  if (flags.LOCAL_INTEGRATION_EMAIL_ENABLED) {
    const emailTo = isDeniedEmailRecipient(process.env.STAGING_EMAIL_TO);
    if (!present('SMTP2GO_API_KEY')) {
      blockers.push('SMTP2GO_API_KEY missing (SMTP2GO is the email provider)');
    }
    if (emailTo.blocked) blockers.push(`Email isolation: ${emailTo.reason}`);
  }

  const webhookHost = parseHttpHost(
    process.env.WEBHOOK_TRADINGVIEW_URL ||
      (process.env.PUBLIC_BACKEND_URL
        ? `${String(process.env.PUBLIC_BACKEND_URL).replace(/\/$/, '')}/api/webhook/tradingview`
        : '')
  );
  if (webhookHost && isProductionHost(webhookHost)) {
    blockers.push('TradingView webhook host looks like production');
  }

  return {
    ok: blockers.length === 0,
    mode: 'LOCAL_INTEGRATION',
    classification: 'REAL LOCAL-INTEGRATION',
    blockers,
    flags,
    mongo: { ...mongo, hostRedacted: redactHost(process.env.MONGODB_URI) },
    redis: { ...redis, hostRedacted: redactHost(process.env.REDIS_URL) },
    apiHostRedacted: apiHost || 'missing',
    loopbackDataPlane: true
  };
}

module.exports = {
  REQUIRED_STAGING_DB,
  REQUIRED_LOCAL_CANARY_DB,
  ROOT,
  truthy,
  present,
  loadEnvStaging,
  loadEnvLocalCanary,
  parseMongoUri,
  parseRedisUri,
  parseHttpHost,
  isProductionHost,
  isLoopbackHost,
  isPlaceholderSecret,
  isTelegramBotTokenShape,
  isProductionMongo,
  isProductionRedis,
  isLocalCanaryMongo,
  isLocalCanaryRedis,
  isDeniedTelegramChat,
  isDeniedEmailRecipient,
  probePort,
  redactHost,
  evaluateIsolation,
  evaluateLocalIntegration
};
