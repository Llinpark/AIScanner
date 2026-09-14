'use strict';

/**
 * Staging health probes. Used by staging-health-check.js and staging-canary.js.
 * Never FLUSHALL. Never send trade alerts. Never prints secrets.
 */

const {
  probePort,
  present,
  parseHttpHost,
  parseMongoUri,
  parseRedisUri,
  isLoopbackHost,
  redactHost
} = require('./stagingIsolation');

async function pingHttp(url, timeoutMs = 2500) {
  if (!url) return { status: 'missing' };
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { method: 'GET', signal: ac.signal });
    clearTimeout(t);
    return { status: res.ok ? 'reachable' : `http_${res.status}`, httpStatus: res.status };
  } catch (err) {
    return { status: 'unreachable', reason: String(err.message || err).slice(0, 80) };
  }
}

async function probeRedisCommands() {
  const url = process.env.REDIS_URL;
  if (!url) return { status: 'missing' };
  const { createClient } = require('redis');
  const prefix = `kaching:staging:health:${Date.now().toString(36)}`;
  const client = createClient({ url, socket: { connectTimeout: 4000 } });
  try {
    await client.connect();
    const nx = `${prefix}:nx`;
    const hash = `${prefix}:h`;
    const first = await client.set(nx, '1', { NX: true, EX: 30 });
    const second = await client.set(nx, '2', { NX: true, EX: 30 });
    await client.set(`${prefix}:k`, 'v', { EX: 30 });
    const got = await client.get(`${prefix}:k`);
    await client.hSet(hash, { a: '1' });
    const h = await client.hGet(hash, 'a');
    const ttl = await client.ttl(nx);
    await client.del(nx, `${prefix}:k`, hash);
    return {
      status: 'reachable',
      setNxFirst: Boolean(first),
      setNxSecondDenied: second == null,
      getOk: got === 'v',
      hashOk: h === '1',
      ttlPositive: ttl > 0 && ttl <= 30
    };
  } catch (err) {
    return { status: 'unreachable', reason: String(err.message || err).slice(0, 100) };
  } finally {
    try {
      await client.quit();
    } catch {
      try {
        await client.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
}

async function probeTelegramNoSend() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.STAGING_TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return { status: 'missing' };
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: ac.signal });
    const me = await meRes.json().catch(() => ({}));
    const chatRes = await fetch(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`,
      { signal: ac.signal }
    );
    const chat = await chatRes.json().catch(() => ({}));
    clearTimeout(t);
    if (!me.ok) return { status: 'unreachable', reason: 'getMe_failed' };
    if (!chat.ok) return { status: 'chat_inaccessible', reason: 'getChat_failed' };
    return { status: 'reachable', evidence: 'getMe+getChat_ok_no_send' };
  } catch (err) {
    return { status: 'unreachable', reason: String(err.message || err).slice(0, 80) };
  }
}

async function probeEmailProviderNoSend() {
  if (present('SMTP2GO_API_KEY')) {
    return { status: 'configured', evidence: 'SMTP2GO_API_KEY_present_no_send' };
  }
  return { status: 'missing', reason: 'SMTP2GO_API_KEY_required' };
}

async function probeMongoPing() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return { status: 'missing' };
  const mongoose = require('mongoose');
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000 });
    const dbName = mongoose.connection.name;
    await mongoose.disconnect();
    return { status: 'reachable', database: dbName };
  } catch (err) {
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
    return { status: 'unreachable', reason: String(err.message || err).slice(0, 100) };
  }
}

async function runHealthProbes(opts = {}) {
  const allowLoopback = opts.allowLoopback === true;
  const requiredDatabase = opts.requiredDatabase || 'kaching_staging';
  const requireTelegram = opts.requireTelegram !== false;
  const requireEmail = opts.requireEmail !== false;
  const requireApi = opts.requireApi !== false;

  const apiBase = String(process.env.PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
  const apiHost = parseHttpHost(process.env.PUBLIC_BACKEND_URL);
  const mongoHost = parseMongoUri(process.env.MONGODB_URI).host;
  const redisHost = parseRedisUri(process.env.REDIS_URL).host;
  const loopback =
    isLoopbackHost(apiHost) || isLoopbackHost(mongoHost) || isLoopbackHost(redisHost);

  if (loopback && !allowLoopback) {
    return {
      verdict: 'BLOCKED',
      realStagingReached: false,
      blockers: ['loopback/localhost is not accepted as real kaching-api-staging'],
      probes: {}
    };
  }

  const redisLocal = await probePort('127.0.0.1', 6379);
  const mongoLocal = await probePort('127.0.0.1', 27017);
  const apiHealth = requireApi ? await pingHttp(`${apiBase}/api/health`) : { status: 'skipped' };
  const redis = await probeRedisCommands();
  const mongo = await probeMongoPing();
  const telegram = requireTelegram ? await probeTelegramNoSend() : { status: 'skipped' };
  const email = requireEmail ? await probeEmailProviderNoSend() : { status: 'skipped' };

  const blockers = [];
  if (requireApi && apiHealth.status !== 'reachable') {
    blockers.push('API health endpoint not reachable');
  }
  if (redis.status !== 'reachable') blockers.push('Redis not reachable');
  if (mongo.status !== 'reachable') blockers.push('MongoDB not reachable');
  if (mongo.database && mongo.database !== requiredDatabase) {
    blockers.push(`Mongo connected to ${mongo.database}, expected ${requiredDatabase}`);
  }
  if (requireTelegram && telegram.status !== 'reachable') {
    blockers.push('Telegram test bot/chat not validated (getMe+getChat, no send)');
  }
  if (requireEmail && email.status !== 'reachable') {
    blockers.push('Email test provider not validated (no send)');
  }

  const probes = {
    API: { status: apiHealth.status, evidence: `${apiBase}/api/health` },
    MongoDB: {
      status: mongo.status,
      database: mongo.database || null,
      evidence: `host=${redactHost(process.env.MONGODB_URI)} local27017=${mongoLocal}`
    },
    Redis: {
      status: redis.status,
      setNx: redis.setNxFirst === true && redis.setNxSecondDenied === true,
      ttl: redis.ttlPositive === true,
      hash: redis.hashOk === true,
      evidence: `host=${redactHost(process.env.REDIS_URL)} local6379=${redisLocal}`
    },
    Telegram: {
      status: telegram.status,
      environment: 'getMe_getChat_no_sendMessage',
      evidence: telegram.evidence || telegram.reason || 'no_send'
    },
    Email: {
      status: email.status,
      environment: 'provider_probe_no_send',
      evidence: email.evidence || email.reason || 'no_send'
    },
    TradingViewWebhook: {
      status: apiHealth.status,
      evidence: `${apiBase}/api/webhook/tradingview`
    }
  };

  return {
    verdict: blockers.length ? 'FAIL' : 'PASS',
    realStagingReached: blockers.length === 0 && !allowLoopback,
    localIntegrationReached: blockers.length === 0 && allowLoopback,
    blockers,
    probes,
    redis
  };
}

module.exports = {
  pingHttp,
  probeRedisCommands,
  probeTelegramNoSend,
  probeEmailProviderNoSend,
  probeMongoPing,
  runHealthProbes
};
