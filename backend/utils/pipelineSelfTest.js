/**
 * Dev-only self-test: one valid entry through the REAL production webhook path
 * (auth → validation → Mongo/in-memory → TradeDelivery).
 *
 * Never bypasses production handlers. Refuses to run when NODE_ENV=production.
 */

const http = require('http');
const { randomUUID } = require('crypto');
const { generateLicenseToken } = require('./webhookSecurity');
const { logPipeline } = require('./pipelineLog');
const { WEBHOOK_TRADINGVIEW_URL } = require('../config/appUrls');

function assertDevOnly() {
  if (process.env.NODE_ENV === 'production') {
    const err = new Error('pipeline self-test is disabled in production');
    err.code = 'self_test_forbidden';
    throw err;
  }
}

function buildValidEntryPayload({ licenseToken, tradingviewUsername, userId, secret } = {}) {
  const signalUuid = `selftest_${randomUUID()}`;
  // Unique symbol avoids ActiveSignalRegistry collisions with live XAUUSD trades.
  const symbol = `STEST${Date.now().toString().slice(-6)}`;
  const payload = {
    symbol,
    strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    timeframe: '3',
    pattern: 'liquidity_sweep_fvg_scalp',
    alertType: 'entry',
    direction: 'long',
    entry: 2650.5,
    stop_loss: 2648.2,
    stop_loss_1: 2648.2,
    take_profit_1: 2655.1,
    take_profit_2: 2657.4,
    take_profit_3: 2659.7,
    confidence: 0.85,
    signalId: signalUuid,
    signalUuid,
    expiryBars: 60,
    enableTradeExpiry: true,
    active: true,
    message: '🟦 Kaching BUY\\nEntry: 2650.5\\nSL: 2648.2\\nTP1: 2655.1\\nTP2: 2657.4\\nTP3: 2659.7',
    broadcast: true,
    selfTest: true
  };

  if (licenseToken && tradingviewUsername && userId) {
    payload.licenseToken = licenseToken;
    payload.tradingviewUsername = tradingviewUsername;
    payload.userId = userId;
  } else if (secret) {
    payload.secret = secret;
  }

  return payload;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'User-Agent': 'KachingPipelineSelfTest/1.0'
        },
        timeout: 15000
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode, body: json, raw: text });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('self-test HTTP timeout'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * In-process path: same functions server.js uses after receive/auth logging.
 */
async function runInProcessSelfTest({ io, inMemorySignals = [] } = {}) {
  assertDevOnly();
  process.env.PIPELINE_SELF_TEST_ACTIVE = 'true';
  const t0 = Date.now();
  const stages = [];

  // Avoid long mongoose buffering hangs when Mongo is configured but unreachable.
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      mongoose.set('bufferCommands', false);
      mongoose.set('bufferTimeoutMS', 1000);
    }
  } catch {
    /* ignore */
  }

  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET || '';
  // Keep signing secret available for both token mint and verify (do not unset mid-test).
  if (!process.env.WEBHOOK_SIGNING_SECRET) {
    process.env.WEBHOOK_SIGNING_SECRET =
      process.env.TRADINGVIEW_WEBHOOK_SECRET ||
      process.env.JWT_SECRET ||
      'dev-self-test-signing-secret';
  }

  // Prefer license auth when we can mint a token; else legacy secret (dev only).
  let payload;
  const testUserId = process.env.PIPELINE_SELFTEST_USER_ID || '000000000000000000000001';
  const testTvu = process.env.PIPELINE_SELFTEST_TV_USERNAME || 'kachingselftest';

  try {
    const licenseToken = generateLicenseToken(testUserId, testTvu);
    payload = buildValidEntryPayload({
      licenseToken,
      tradingviewUsername: testTvu,
      userId: testUserId,
      secret: secret || undefined
    });
  } catch (err) {
    if (!secret) {
      throw new Error(
        `Cannot mint license token (${err.message}). Set TRADINGVIEW_WEBHOOK_SECRET or WEBHOOK_SIGNING_SECRET/JWT_SECRET.`
      );
    }
    payload = buildValidEntryPayload({ secret });
  }

  stages.push(
    logPipeline('SelfTest', 'PASS', {
      symbol: payload.symbol,
      timeframe: payload.timeframe,
      signalUuid: payload.signalUuid,
      reason: 'payload_built'
    })
  );

  const { verifyTradingViewWebhook } = require('./webhookSecurity');
  const MarketScannerService = require('../services/MarketScannerService');
  const { resolveUserById } = require('../middleware/requireAuth');

  const fakeReq = {
    body: payload,
    headers: {},
    rawBody: Buffer.from(JSON.stringify(payload), 'utf8'),
    ip: '127.0.0.1'
  };

  // For license auth without a real DB user, inject a resolver that returns an active sub.
  const resolveUser = async id => {
    if (String(id) === String(testUserId)) {
      return {
        _id: testUserId,
        id: testUserId,
        email: 'pipeline-selftest@localhost',
        role: 'admin',
        tradingviewUsername: testTvu,
        subscription: {
          status: 'active',
          tier: 'premium',
          current_period_end: new Date(Date.now() + 86400000 * 30)
        },
        preferences: { tradingviewUsername: testTvu, emailAlerts: false }
      };
    }
    if (typeof resolveUserById === 'function') {
      try {
        return await resolveUserById(id);
      } catch {
        return null;
      }
    }
    return null;
  };

  const auth = await verifyTradingViewWebhook(fakeReq, resolveUser);
  stages.push(
    logPipeline('Auth', auth.ok ? 'PASS' : 'FAIL', {
      symbol: payload.symbol,
      timeframe: payload.timeframe,
      signalUuid: payload.signalUuid,
      reason: auth.ok ? `mode=${auth.mode}` : auth.reason || 'unauthorized'
    })
  );
  if (!auth.ok) {
    return {
      ok: false,
      mode: 'in_process',
      stages,
      auth,
      latencyMs: Date.now() - t0,
      error: auth.reason || 'auth_failed'
    };
  }

  try {
    // Production publish path (same as server.js after auth).
    const result = await MarketScannerService.publishTradingViewAlert(
      io || { emit() {}, to() { return { emit() {} }; } },
      auth.body || payload,
      inMemorySignals
    );

    const latencyMs = Date.now() - t0;
    const ok = Boolean(result) && !result.rejected;
    stages.push(
      logPipeline('SelfTestComplete', ok ? 'PASS' : 'FAIL', {
        symbol: payload.symbol,
        timeframe: payload.timeframe,
        signalUuid: result?.signalUuid || payload.signalUuid,
        reason: ok
          ? `delivered=${result.delivered ?? 0}; latencyMs=${latencyMs}`
          : result?.reason || 'publish_rejected'
      })
    );

    const savedInMemory = Array.isArray(inMemorySignals)
      ? inMemorySignals.find(
          s =>
            String(s.signalUuid || s.signalId) ===
            String(result?.signalUuid || payload.signalUuid)
        )
      : null;

    return {
      ok,
      mode: 'in_process',
      webhookUrl: WEBHOOK_TRADINGVIEW_URL,
      signalUuid: result?.signalUuid || payload.signalUuid,
      result,
      savedSignalId: savedInMemory?._id || null,
      mongoConnected: require('mongoose').connection.readyState === 1,
      stages,
      latencyMs,
      note:
        'In-process uses verifyTradingViewWebhook + MarketScannerService.publishTradingViewAlert (same production chain as POST /api/webhook/tradingview). External email/Telegram/MT5 skipped while PIPELINE_SELF_TEST_ACTIVE=true.'
    };
  } finally {
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
  }
}

/**
 * HTTP path against an already-running server (PUBLIC_BACKEND_URL).
 * Uses legacy secret auth in non-production when available.
 */
async function runHttpSelfTest({ baseUrl } = {}) {
  assertDevOnly();
  const t0 = Date.now();
  const secret = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('HTTP self-test requires TRADINGVIEW_WEBHOOK_SECRET in env');
  }

  const root = (baseUrl || process.env.PUBLIC_BACKEND_URL || 'http://127.0.0.1:4000').replace(
    /\/$/,
    ''
  );
  const url = `${root}/api/webhook/tradingview`;
  const payload = buildValidEntryPayload({ secret });

  logPipeline('SelfTestHttp', 'PASS', {
    symbol: payload.symbol,
    timeframe: payload.timeframe,
    signalUuid: payload.signalUuid,
    reason: `posting ${url}`
  });

  const response = await postJson(url, payload);
  const latencyMs = Date.now() - t0;
  const ok =
    response.status >= 200 &&
    response.status < 300 &&
    response.body?.success === true &&
    !response.body?.rejected;

  logPipeline('SelfTestHttpComplete', ok ? 'PASS' : 'FAIL', {
    symbol: payload.symbol,
    timeframe: payload.timeframe,
    signalUuid: response.body?.signalUuid || payload.signalUuid,
    reason: `http=${response.status}; latencyMs=${latencyMs}; rejected=${Boolean(response.body?.rejected)}`
  });

  return {
    ok,
    mode: 'http',
    url,
    status: response.status,
    body: response.body,
    signalUuid: response.body?.signalUuid || payload.signalUuid,
    latencyMs
  };
}

/**
 * Spin up a minimal Express server that uses the SAME production auth + publish
 * functions as server.js POST /api/webhook/tradingview, then HTTP POST into it.
 */
async function runLocalHttpHarnessSelfTest({ inMemorySignals = [] } = {}) {
  assertDevOnly();
  process.env.PIPELINE_SELF_TEST_ACTIVE = 'true';

  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      mongoose.set('bufferCommands', false);
      mongoose.set('bufferTimeoutMS', 1000);
    }
  } catch {
    /* ignore */
  }

  if (!process.env.WEBHOOK_SIGNING_SECRET) {
    process.env.WEBHOOK_SIGNING_SECRET =
      process.env.TRADINGVIEW_WEBHOOK_SECRET ||
      process.env.JWT_SECRET ||
      'dev-self-test-signing-secret';
  }

  const express = require('express');
  const { verifyTradingViewWebhook } = require('./webhookSecurity');
  const MarketScannerService = require('../services/MarketScannerService');
  const { logPipeline: plog, extractPipelineMeta, clientIp, payloadSize } = require('./pipelineLog');

  const testUserId = process.env.PIPELINE_SELFTEST_USER_ID || '000000000000000000000001';
  const testTvu = process.env.PIPELINE_SELFTEST_TV_USERNAME || 'kachingselftest';
  const licenseToken = generateLicenseToken(testUserId, testTvu);
  const payload = buildValidEntryPayload({
    licenseToken,
    tradingviewUsername: testTvu,
    userId: testUserId
  });

  const resolveUser = async id => {
    if (String(id) !== String(testUserId)) return null;
    return {
      _id: testUserId,
      id: testUserId,
      email: 'pipeline-selftest@localhost',
      role: 'admin',
      tradingviewUsername: testTvu,
      subscription: {
        status: 'active',
        tier: 'premium',
        current_period_end: new Date(Date.now() + 86400000 * 30)
      },
      preferences: { tradingviewUsername: testTvu, emailAlerts: false }
    };
  };

  const app = express();
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        if (buf?.length) req.rawBody = buf;
      }
    })
  );

  // Mirrors server.js POST /api/webhook/tradingview (receive → auth → publish).
  app.post('/api/webhook/tradingview', async (req, res) => {
    const t0 = Date.now();
    const earlyMeta = extractPipelineMeta(req.body || {});
    const size = payloadSize(req);
    const ip = clientIp(req);
    console.log(
      `[TV WEBHOOK RECEIVED] timestamp=${new Date().toISOString()} ip=${ip} ` +
        `symbol=${earlyMeta.symbol || 'n/a'} timeframe=${earlyMeta.timeframe || 'n/a'} ` +
        `signalUuid=${earlyMeta.signalUuid || 'n/a'} payloadBytes=${size}`
    );
    plog('WebhookReceived', 'PASS', { ...earlyMeta, reason: `ip=${ip}; bytes=${size}` });

    try {
      const auth = await verifyTradingViewWebhook(req, resolveUser);
      if (!auth.ok) {
        plog('Auth', 'FAIL', { ...earlyMeta, reason: auth.reason || 'unauthorized' });
        return res.status(401).json({ message: 'Invalid webhook authentication', reason: auth.reason });
      }
      plog('Auth', 'PASS', {
        ...extractPipelineMeta(auth.body || req.body),
        reason: `mode=${auth.mode}`
      });

      const result = await MarketScannerService.publishTradingViewAlert(
        { emit() {}, to() { return { emit() {} }; } },
        auth.body || req.body,
        inMemorySignals
      );
      const latencyMs = Date.now() - t0;
      plog('Publish', result?.rejected ? 'FAIL' : 'PASS', {
        ...extractPipelineMeta(auth.body || req.body),
        signalUuid: result?.signalUuid,
        reason: `delivered=${result?.delivered ?? 0}; latencyMs=${latencyMs}`
      });
      return res.status(201).json({ success: true, latencyMs, ...result });
    } catch (error) {
      plog('Validation', 'FAIL', {
        ...earlyMeta,
        reason: error.rejectedFields?.join(',') || error.message
      });
      return res.status(500).json({ message: error.message, rejectedFields: error.rejectedFields });
    }
  });

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/webhook/tradingview`;

  try {
    const t0 = Date.now();
    logPipeline('SelfTestHttpHarness', 'PASS', {
      symbol: payload.symbol,
      timeframe: payload.timeframe,
      signalUuid: payload.signalUuid,
      reason: `posting ${url}`
    });

    const response = await postJson(url, payload);
    const latencyMs = Date.now() - t0;
    const ok =
      response.status >= 200 &&
      response.status < 300 &&
      response.body?.success === true &&
      !response.body?.rejected;

    const saved = inMemorySignals.find(
      s => String(s.signalUuid || s.signalId) === String(response.body?.signalUuid || payload.signalUuid)
    );

    logPipeline('SelfTestHttpHarnessComplete', ok ? 'PASS' : 'FAIL', {
      symbol: payload.symbol,
      timeframe: payload.timeframe,
      signalUuid: response.body?.signalUuid || payload.signalUuid,
      reason: `http=${response.status}; saved=${saved?._id || 'none'}; latencyMs=${latencyMs}`
    });

    return {
      ok,
      mode: 'http_harness',
      url,
      status: response.status,
      body: response.body,
      signalUuid: response.body?.signalUuid || payload.signalUuid,
      savedSignalId: saved?._id || null,
      mongoConnected: require('mongoose').connection.readyState === 1,
      latencyMs,
      note:
        'HTTP harness uses production verifyTradingViewWebhook + MarketScannerService.publishTradingViewAlert via real Express POST /api/webhook/tradingview.'
    };
  } finally {
    delete process.env.PIPELINE_SELF_TEST_ACTIVE;
    await new Promise(resolve => server.close(resolve));
  }
}

async function runPipelineSelfTest(options = {}) {
  assertDevOnly();
  if (options.http) {
    return runHttpSelfTest(options);
  }
  if (options.httpHarness !== false && !options.inProcessOnly) {
    // Default CLI: prove real HTTP → webhook handler → auth → save → delivery.
    return runLocalHttpHarnessSelfTest(options);
  }
  return runInProcessSelfTest(options);
}

module.exports = {
  assertDevOnly,
  buildValidEntryPayload,
  runInProcessSelfTest,
  runHttpSelfTest,
  runLocalHttpHarnessSelfTest,
  runPipelineSelfTest
};
