'use strict';

/**
 * Shared Redis client for production authority (SET NX claims, leases).
 *
 * Failure modes this file exists to prevent:
 * 1. reconnectStrategy:false + latched connectPromise returns a CLOSED client
 *    forever → every SET NX throws "The client is closed" → false 503s while
 *    Upstash is actually reachable from a fresh client.
 * 2. Permanent redisUnavailable latch / poisoned connectPromise after the first
 *    connect() failure.
 * 3. Offline command queue hanging forever when the socket dies.
 *
 * Recovery is safe recreation (not node-redis infinite reconnect): a closed
 * client is retired; the next getRedisClient() single-flights a new connection
 * using the same REDIS_URL/TLS. Genuine Redis outage still returns null →
 * callers fail-closed (HTTP 503). Process-local claim/fan-out fallback is NOT
 * added here.
 */

const crypto = require('crypto');
const { withTimeout } = require('./boundedWait');

const DEFAULT_CONNECT_TIMEOUT_MS = 4000;
const DEFAULT_COMMAND_TIMEOUT_MS = 3000;
const DEFAULT_RECREATE_COOLDOWN_MS = 1000;

let createClientImpl = null;
function defaultCreateClient() {
  if (!createClientImpl) {
    createClientImpl = require('redis').createClient;
  }
  return createClientImpl;
}

let currentClient = null;
let connectPromise = null;
let connectingClient = null;
let shuttingDown = false;
let generation = 0;
let redisUnavailableUntil = 0;
let lastError = null;
let lastErrorAt = null;
let lastErrorCode = null;
let lastSuccessfulOp = null;
let lastSuccessfulAt = null;
let lastLatencyMs = null;
let lastDiscardAt = 0;
let recreateCount = 0;
let connectionState = 'disconnected';

function isRedisEnabled() {
  const flag = String(process.env.REDIS_ENABLED ?? 'true').trim().toLowerCase();
  return flag !== 'false' && flag !== '0' && flag !== 'off';
}

function recreateCooldownMs() {
  const raw = Number(process.env.REDIS_RECREATE_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return DEFAULT_RECREATE_COOLDOWN_MS;
}

function classifyRedisError(err) {
  const msg = String(err?.message || err || '');
  const code = String(err?.code || err?.reason || '');
  if (/client is closed/i.test(msg) || code === 'redis_client_closed') return 'redis_client_closed';
  if (/ECONNREFUSED/i.test(msg) || code === 'ECONNREFUSED') return 'redis_econnrefused';
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return 'redis_dns';
  if (/ETIMEDOUT|timed out|timeout|ECONNRESET/i.test(msg) || code === 'ETIMEDOUT' || code === 'DIAG_TIMEOUT') {
    return 'redis_timeout';
  }
  if (/NOAUTH|WRONGPASS|invalid password|invalid username/i.test(msg)) return 'redis_auth_failed';
  if (/CERT|UNABLE_TO_VERIFY|TLS|SSL/i.test(msg)) return 'redis_tls_failed';
  if (/reconnect_exhausted/i.test(msg)) return 'redis_reconnect_exhausted';
  return 'redis_unavailable';
}

function classifyConnectionState() {
  if (shuttingDown) return 'shutting_down';
  if (!isRedisEnabled()) return 'disabled';
  if (connectPromise) return 'reconnecting';
  if (isClientUsable(currentClient)) return 'healthy';
  if (currentClient && !isClientUsable(currentClient)) return 'closed-stale';
  const code = lastErrorCode;
  if (code === 'redis_auth_failed' || code === 'redis_tls_failed') return 'auth-config';
  if (
    code === 'redis_timeout' ||
    code === 'redis_econnrefused' ||
    code === 'redis_dns' ||
    code === 'redis_unavailable' ||
    code === 'redis_reconnect_exhausted'
  ) {
    return Date.now() < redisUnavailableUntil ? 'temporarily_unavailable' : 'temporarily_unavailable';
  }
  if (code === 'redis_client_closed') return 'closed-stale';
  if (!process.env.REDIS_URL) return 'not_configured';
  return connectionState || 'disconnected';
}

function isClosedError(err) {
  return classifyRedisError(err) === 'redis_client_closed';
}

function isClientUsable(c) {
  return Boolean(c && c.isOpen === true && c.isReady === true);
}

function markError(err) {
  lastError = String(err?.message || err || 'unknown').slice(0, 220);
  lastErrorAt = new Date().toISOString();
  lastErrorCode = classifyRedisError(err);
}

function markSuccess(op, latencyMs) {
  lastSuccessfulOp = op;
  lastSuccessfulAt = new Date().toISOString();
  if (Number.isFinite(latencyMs)) lastLatencyMs = latencyMs;
}

function connectTimeoutMs() {
  const raw = Number(process.env.REDIS_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONNECT_TIMEOUT_MS;
}

function commandTimeoutMs() {
  const raw = Number(process.env.REDIS_COMMAND_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMMAND_TIMEOUT_MS;
}

function redisUrl() {
  return String(process.env.REDIS_URL || 'redis://127.0.0.1:6379/0');
}

function urlFingerprint() {
  const url = process.env.REDIS_URL || '';
  if (!url) return { configured: false, scheme: 'missing', port: null, hostFingerprint: null };
  try {
    const u = new URL(url);
    return {
      configured: true,
      scheme: u.protocol.replace(':', '') || 'unknown',
      port: u.port || (u.protocol === 'rediss:' ? '6379' : '6379'),
      hostFingerprint: crypto.createHash('sha256').update(u.hostname || '').digest('hex').slice(0, 12)
    };
  } catch {
    return { configured: true, scheme: 'unparseable', port: null, hostFingerprint: null };
  }
}

function logLifecycle(event, extra = '') {
  const bits = [
    `[${event}]`,
    `machine=${process.env.FLY_MACHINE_ID || 'n/a'}`,
    `generation=${generation}`,
    extra
  ].filter(Boolean);
  const line = bits.join(' ');
  if (/FAILURE|CLOSED/.test(event)) console.warn(line);
  else console.log(line);
}

function quietQuit(c) {
  if (!c) return;
  try {
    if (typeof c.removeAllListeners === 'function') c.removeAllListeners();
  } catch {
    /* ignore */
  }
  try {
    if (typeof c.disconnect === 'function') {
      Promise.resolve(c.disconnect()).catch(() => {});
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof c.quit === 'function') Promise.resolve(c.quit()).catch(() => {});
  } catch {
    /* ignore */
  }
}

function discardClient(reason, { alreadyLogged } = {}) {
  const old = currentClient;
  currentClient = null;
  if (connectingClient === old) connectingClient = null;
  recreateCount += 1;
  lastDiscardAt = Date.now();
  connectionState = reason === 'shutdown' || shuttingDown ? 'shutting_down' : 'closed-stale';
  if (!alreadyLogged) {
    logLifecycle('REDIS_CLIENT_CLOSED', `reason=${reason} recreates=${recreateCount}`);
  }
  if (old) quietQuit(old);
}

function invalidateRedisClient(reason) {
  markError(reason instanceof Error ? reason : new Error(String(reason || 'invalidate')));
  discardClient(typeof reason === 'string' ? reason : classifyRedisError(reason));
}

/**
 * node-redis internal reconnect is disabled on purpose. reconnectStrategy:false
 * was the production bug only because a closed client + latched connectPromise
 * were reused forever. We recreate via getRedisClient() instead of looping
 * inside the socket layer (no infinite / zero-delay storms).
 */
function reconnectStrategy() {
  return false;
}

function attachLifecycle(nextClient) {
  const onClosed = (kind, err) => {
    markError(err || new Error(kind));
    connectionState = 'closed-stale';
    logLifecycle('REDIS_CLIENT_CLOSED', `reason=${kind} code=${lastErrorCode}`);
    if (shuttingDown) return;
    // Only retire the published singleton. connectFresh() owns in-flight cleanup
    // so error/end during connect cannot wipe a newer connectPromise.
    if (currentClient === nextClient) {
      discardClient(kind, { alreadyLogged: true });
    }
  };

  nextClient.on('error', err => {
    markError(err);
    if (isClosedError(err) || nextClient.isOpen !== true) {
      onClosed(classifyRedisError(err), err);
    }
  });

  nextClient.on('end', () => onClosed('connection_ended'));
  nextClient.on('close', () => onClosed('connection_closed'));
}

async function connectFresh() {
  if (shuttingDown) {
    connectionState = 'shutting_down';
    return null;
  }
  const url = redisUrl();
  const timeoutMs = connectTimeoutMs();
  const t0 = Date.now();
  const isReconnect = generation > 0 || recreateCount > 0;
  let nextClient = null;
  connectionState = 'reconnecting';
  logLifecycle(isReconnect ? 'REDIS_CLIENT_RECONNECT_START' : 'REDIS_CLIENT_CONNECT_START');
  try {
    const createClient = defaultCreateClient();
    nextClient = createClient({
      url,
      socket: {
        connectTimeout: timeoutMs,
        reconnectStrategy,
        tls: url.startsWith('rediss://') || undefined
      },
      disableOfflineQueue: true,
      pingInterval: 15000
    });
    connectingClient = nextClient;
    attachLifecycle(nextClient);

    await withTimeout(nextClient.connect(), timeoutMs + 250, 'redis_connect');
    if (shuttingDown) {
      quietQuit(nextClient);
      connectingClient = null;
      connectionState = 'shutting_down';
      return null;
    }
    if (!isClientUsable(nextClient)) {
      throw new Error('The client is closed');
    }
    generation += 1;
    currentClient = nextClient;
    connectingClient = null;
    redisUnavailableUntil = 0;
    connectionState = 'healthy';
    markSuccess('connect', Date.now() - t0);
    logLifecycle(
      isReconnect ? 'REDIS_CLIENT_RECONNECT_SUCCESS' : 'REDIS_CLIENT_CONNECT_SUCCESS',
      `latencyMs=${lastLatencyMs}`
    );
    return currentClient;
  } catch (error) {
    markError(error);
    const state = classifyConnectionState();
    connectionState =
      lastErrorCode === 'redis_auth_failed' || lastErrorCode === 'redis_tls_failed'
        ? 'auth-config'
        : 'temporarily_unavailable';
    logLifecycle('REDIS_CLIENT_CONNECT_FAILURE', `code=${lastErrorCode} state=${state}`);
    if (connectingClient === nextClient) connectingClient = null;
    if (currentClient === nextClient) currentClient = null;
    quietQuit(nextClient);
    redisUnavailableUntil = Date.now() + recreateCooldownMs() * 2;
    return null;
  }
}

async function getRedisClient() {
  if (!isRedisEnabled()) {
    connectionState = 'disabled';
    return null;
  }
  if (shuttingDown) {
    connectionState = 'shutting_down';
    return null;
  }

  if (isClientUsable(currentClient)) {
    connectionState = 'healthy';
    return currentClient;
  }

  if (currentClient && !isClientUsable(currentClient)) {
    connectionState = 'closed-stale';
    discardClient('client_not_open');
  }

  if (connectPromise) {
    connectionState = 'reconnecting';
    return connectPromise;
  }

  const now = Date.now();
  const cooldown = recreateCooldownMs();
  if (now < redisUnavailableUntil) {
    connectionState = lastErrorCode === 'redis_auth_failed' || lastErrorCode === 'redis_tls_failed'
      ? 'auth-config'
      : 'temporarily_unavailable';
    return null;
  }
  if (recreateCount >= 2 && lastDiscardAt > 0 && cooldown > 0 && now - lastDiscardAt < cooldown) {
    connectionState = 'temporarily_unavailable';
    return null;
  }

  const flight = connectFresh();
  connectPromise = flight;
  try {
    const resolved = await flight;
    if (resolved && !isClientUsable(resolved)) {
      discardClient('resolved_unusable');
      return null;
    }
    return resolved;
  } finally {
    if (connectPromise === flight) connectPromise = null;
  }
}

async function pingRedis({ timeoutMs } = {}) {
  const t0 = Date.now();
  try {
    const c = await withTimeout(getRedisClient(), timeoutMs || commandTimeoutMs(), 'redis_client');
    if (!c) {
      return { ok: false, code: lastErrorCode || 'redis_unavailable', latencyMs: Date.now() - t0 };
    }
    if (typeof c.ping === 'function') {
      await withTimeout(c.ping(), timeoutMs || commandTimeoutMs(), 'redis_ping');
    }
    markSuccess('ping', Date.now() - t0);
    return { ok: true, code: 'ok', latencyMs: Date.now() - t0 };
  } catch (err) {
    markError(err);
    if (isClosedError(err)) invalidateRedisClient(err);
    return { ok: false, code: classifyRedisError(err), latencyMs: Date.now() - t0 };
  }
}

function getRedisDiagnostics() {
  const fp = urlFingerprint();
  const open = Boolean(currentClient && currentClient.isOpen === true);
  const ready = Boolean(currentClient && currentClient.isReady === true);
  const state = classifyConnectionState();
  return {
    redisConfigured: fp.configured && isRedisEnabled(),
    redisEnabled: isRedisEnabled(),
    redisConnected: isClientUsable(currentClient),
    redisClientOpen: open,
    redisClientReady: ready,
    redisConnectionState: state,
    redisLastError: lastError,
    redisReconnectInProgress: Boolean(connectPromise),
    redisScheme: fp.scheme,
    redisPort: fp.port,
    hostFingerprint: fp.hostFingerprint,
    lastSuccessfulRedisOperation: lastSuccessfulOp,
    lastSuccessfulRedisAt: lastSuccessfulAt,
    lastRedisError: lastError,
    lastRedisErrorCode: lastErrorCode,
    lastRedisErrorAt: lastErrorAt,
    redisLatencyMs: lastLatencyMs,
    recreateCount,
    generation,
    shuttingDown,
    machineId: process.env.FLY_MACHINE_ID || null
  };
}

/**
 * Intentional process shutdown: do not spawn a replacement connection.
 * After a process restart, shuttingDown is false again and connect works.
 */
function shutdownRedis(reason = 'process_shutdown') {
  shuttingDown = true;
  connectionState = 'shutting_down';
  logLifecycle('REDIS_CLIENT_CLOSED', `reason=shutdown ${reason}`);
  const inflight = connectingClient;
  connectingClient = null;
  connectPromise = null;
  discardClient('shutdown', { alreadyLogged: true });
  if (inflight) quietQuit(inflight);
}

function setCreateClientForTests(fn) {
  createClientImpl = fn || null;
}

function resetForTests() {
  shuttingDown = false;
  quietQuit(currentClient);
  quietQuit(connectingClient);
  currentClient = null;
  connectingClient = null;
  connectPromise = null;
  generation = 0;
  redisUnavailableUntil = 0;
  lastError = null;
  lastErrorAt = null;
  lastErrorCode = null;
  lastSuccessfulOp = null;
  lastSuccessfulAt = null;
  lastLatencyMs = null;
  recreateCount = 0;
  lastDiscardAt = 0;
  connectionState = 'disconnected';
  createClientImpl = null;
}

module.exports = {
  getRedisClient,
  isRedisEnabled,
  classifyRedisError,
  isClosedError,
  invalidateRedisClient,
  pingRedis,
  getRedisDiagnostics,
  shutdownRedis,
  setCreateClientForTests,
  resetForTests,
  RECREATE_COOLDOWN_MS: DEFAULT_RECREATE_COOLDOWN_MS
};
