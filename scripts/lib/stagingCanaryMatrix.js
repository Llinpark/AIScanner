'use strict';

/**
 * Real staging canary matrix. Invoked only after isolation + health PASS.
 * Writes only documents tagged with soakRunId. Cleans up only those records.
 * Never FLUSHALL. Never fly deploy.
 */

const bcrypt = require('bcryptjs');
const {
  REQUIRED_STAGING_DB,
  truthy,
  isDeniedTelegramChat,
  isDeniedEmailRecipient
} = require('./stagingIsolation');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function classify(status, detail, passLabel = 'REAL') {
  return { status, classification: status === 'PASS' ? passLabel : status, detail };
}

function payload(alertType, uuid, userId, tvUser, extras = {}) {
  const eventType = {
    entry: 'ENTRY',
    take_profit_1: 'TP1',
    take_profit_2: 'TP2',
    take_profit_3: 'TP3',
    stop_loss: 'SL'
  }[alertType] || 'ENTRY';
  const seq = { ENTRY: 0, TP1: 1, TP2: 2, TP3: 3, SL: 3 }[eventType];
  return {
    symbol: 'XAUUSD',
    strategyName: 'Liquidity Sweep + Fair Value Gap (Scalping)',
    timeframe: '3',
    pattern: 'liquidity_sweep_fvg_scalp',
    alertType,
    direction: 'long',
    entry: 2650.5,
    stop_loss: 2648.2,
    stop_loss_1: 2648.2,
    take_profit_1: 2655.1,
    take_profit_2: 2657.4,
    take_profit_3: 2659.7,
    confidence: 0.85,
    signalUuid: uuid,
    signalId: uuid,
    canonicalTradeId: uuid,
    eventId: `XAUUSD|3|${uuid}|${eventType}`,
    eventType,
    eventSequence: seq,
    message: alertType === 'entry' ? 'KACHING BUY' : `KACHING ${alertType}`,
    broadcast: false,
    tradingviewUsername: tvUser,
    userId: String(userId),
    isRealtime: true,
    pineClientVersion: '1.6.0',
    signalTime: Date.now(),
    capabilities: [
      'canonical_emit_independent_v1',
      'canonical_webhook_authority_v1'
    ],
    ...extras
  };
}

async function postWebhook(body) {
  const { generateLicenseToken, signRequestBody } = require('../../utils/webhookSecurity');
  const licensed = {
    ...body,
    licenseToken: generateLicenseToken(body.userId, body.tradingviewUsername)
  };
  const raw = JSON.stringify(licensed);
  const apiBase = String(process.env.PUBLIC_BACKEND_URL || '').replace(/\/$/, '');
  const res = await fetch(`${apiBase}/api/webhook/tradingview`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kaching-signature': signRequestBody(raw)
    },
    body: raw
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { httpStatus: res.status, json };
}

async function waitJobs(DeliveryJob, { eventId, expectedDelivered = 2, timeoutMs = 45000 }) {
  const start = Date.now();
  let rows = [];
  while (Date.now() - start < timeoutMs) {
    rows = await DeliveryJob.find({
      eventId,
      channel: { $in: ['email', 'telegram'] }
    }).lean();
    if (expectedDelivered <= 0) return rows;
    const delivered = rows.filter(j => j.state === 'delivered');
    if (delivered.length >= expectedDelivered) return rows;
    await sleep(1500);
  }
  return rows;
}

async function runCanaryMatrix({
  runId,
  requiredDatabase = REQUIRED_STAGING_DB,
  passLabel = 'REAL',
  requireTelegram = true,
  requireEmail = true
} = {}) {
  const mongoose = require('mongoose');
  const UserConfig = require('../../models/User');
  const Signal = require('../../models/Signal');
  const DeliveryJob = require('../../models/DeliveryJob');

  const pass = (status, detail) => classify(status, detail, passLabel);
  const expectedDelivered = (requireEmail ? 1 : 0) + (requireTelegram ? 1 : 0);

  if (requireTelegram) {
    const chatCheck = isDeniedTelegramChat(process.env.STAGING_TELEGRAM_CHAT_ID);
    if (chatCheck.blocked) {
      return { executed: false, scenarios: { A_ENTRY: pass('BLOCKED', chatCheck.reason) } };
    }
  }
  if (requireEmail) {
    const emailCheck = isDeniedEmailRecipient(process.env.STAGING_EMAIL_TO);
    if (emailCheck.blocked) {
      return { executed: false, scenarios: { A_ENTRY: pass('BLOCKED', emailCheck.reason) } };
    }
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  if (mongoose.connection.name !== requiredDatabase) {
    const name = mongoose.connection.name;
    await mongoose.disconnect();
    throw new Error(`refusing canary: mongo db ${name} is not ${requiredDatabase}`);
  }

  const tvUser = `stgcanary_${runId}`;
  const canaryEmail = requireEmail
    ? String(process.env.STAGING_EMAIL_TO).trim().toLowerCase()
    : `local-canary-${runId}@example.com`;
  const others = await UserConfig.countDocuments({
    $or: [
      { 'preferences.stagingCanary': { $ne: true } },
      { 'preferences.stagingCanary': { $exists: false } }
    ]
  });
  if (others > 0 && !truthy('STAGING_ALLOW_EXISTING_USERS')) {
    await mongoose.disconnect();
    return {
      executed: false,
      blockers: [
        `${requiredDatabase} has ${others} non-canary user(s); refuse fan-out (set STAGING_ALLOW_EXISTING_USERS=true only if this is intentional)`
      ],
      scenarios: {
        A_ENTRY: pass('BLOCKED', 'non_canary_users_present')
      }
    };
  }

  const passwordHash = bcrypt.hashSync(`canary-${runId}`, 8);
  const user = await UserConfig.findOneAndUpdate(
    { email: canaryEmail },
    {
      $set: {
        email: canaryEmail,
        passwordHash,
        displayName: 'Local/Staging Canary',
        tradingviewUsername: tvUser,
        preferences: {
          emailAlerts: requireEmail,
          stagingCanary: true,
          soakRunId: runId
        },
        telegram: {
          chatId: requireTelegram ? String(process.env.STAGING_TELEGRAM_CHAT_ID) : null,
          enabled: requireTelegram,
          telegramMode: 'alerts_only'
        },
        mt5: { executionMode: 'manual', enabled: false, devices: [] },
        subscription: {
          tier: 'professional',
          status: 'active',
          provider: 'admin',
          paymentSource: 'ADMIN',
          startDate: new Date(),
          current_period_end: new Date(Date.now() + 7 * 24 * 3600 * 1000)
        }
      }
    },
    { upsert: true, new: true }
  );

  const scenarios = {};
  const jobsOut = [];

  async function trade(letter, steps) {
    const uuid = `stgcanary-${runId}-${letter}`;
    const results = [];
    for (const alertType of steps) {
      const body = payload(alertType, uuid, user._id, tvUser);
      const posted = await postWebhook(body);
      if (expectedDelivered === 0) await sleep(2000);
      const jobs = await waitJobs(DeliveryJob, { eventId: body.eventId, expectedDelivered });
      results.push({ alertType, eventType: body.eventType, eventId: body.eventId, posted, jobs });
      jobsOut.push(...jobs.map(j => ({
        jobId: j.jobId,
        channel: j.channel,
        eventType: j.eventType,
        eventId: j.eventId,
        canonicalTradeId: j.canonicalTradeId,
        state: j.state
      })));
    }
    const signal = await Signal.findOne({
      $or: [{ signalUuid: uuid }, { canonicalTradeId: uuid }]
    }).lean();
    return { uuid, signal, results };
  }

  try {
    const channelOk = (emailJobs, tgJobs) =>
      (!requireEmail || emailJobs.length === 1) && (!requireTelegram || tgJobs.length === 1);

    const a = await trade('A', ['entry']);
    const aEmail = (a.results[0].jobs || []).filter(j => j.channel === 'email' && j.state === 'delivered');
    const aTg = (a.results[0].jobs || []).filter(j => j.channel === 'telegram' && j.state === 'delivered');
    const signalIsEntry =
      a.signal &&
      (String(a.signal.alertType || '').toLowerCase() === 'entry' ||
        a.signal.alertType == null);
    scenarios.A_ENTRY = pass(channelOk(aEmail, aTg) && signalIsEntry ? 'PASS' : 'FAIL', {
      canonicalTradeId: a.uuid,
      eventId: a.results[0].eventId,
      emailJobs: aEmail.length,
      telegramJobs: aTg.length,
      signalAlertType: a.signal && a.signal.alertType,
      http: a.results[0].posted.httpStatus
    });

    const b = await trade('B', ['entry', 'take_profit_1']);
    const bTp1 = b.results[1];
    const bEmail = (bTp1.jobs || []).filter(j => j.channel === 'email' && j.state === 'delivered');
    const bTg = (bTp1.jobs || []).filter(j => j.channel === 'telegram' && j.state === 'delivered');
    const sameId = b.results.every(r => r.posted);
    const overlayJobs = bEmail.concat(bTg);
    const overlayOk =
      b.signal &&
      String(b.signal.alertType || 'entry').toLowerCase() !== 'take_profit_1' &&
      (overlayJobs.length === 0 ||
        overlayJobs.every(j => {
          const t = String(j.eventType || '').toLowerCase();
          return t === 'tp1' || t === 'take_profit_1';
        }));
    scenarios.B_ENTRY_TP1 = pass(
      channelOk(bEmail, bTg) && sameId && overlayOk ? 'PASS' : 'FAIL',
      {
        canonicalTradeId: b.uuid,
        entryEventId: b.results[0].eventId,
        tp1EventId: bTp1.eventId,
        emailJobs: bEmail.length,
        telegramJobs: bTg.length,
        signalAlertType: b.signal && b.signal.alertType,
        overlay: overlayOk ? 'signal_remains_ENTRY_jobs_TP1' : 'overlay_mismatch'
      }
    );

    const c = await trade('C', ['entry', 'take_profit_1', 'take_profit_2', 'take_profit_3']);
    const cOk = c.results.every(r => {
      const em = (r.jobs || []).filter(j => j.channel === 'email' && j.state === 'delivered');
      const tg = (r.jobs || []).filter(j => j.channel === 'telegram' && j.state === 'delivered');
      return channelOk(em, tg);
    });
    scenarios.C_ENTRY_TP1_TP2_TP3 = pass(cOk ? 'PASS' : 'FAIL', {
      canonicalTradeId: c.uuid,
      events: c.results.map(r => r.eventId)
    });

    const d = await trade('D', ['entry', 'stop_loss']);
    const dSl = d.results[1];
    const dEmail = (dSl.jobs || []).filter(j => j.channel === 'email' && j.state === 'delivered');
    const dTg = (dSl.jobs || []).filter(j => j.channel === 'telegram' && j.state === 'delivered');
    const tpAfterSl = await DeliveryJob.countDocuments({
      canonicalTradeId: d.uuid,
      eventType: /TP[123]|take_profit/i
    });
    scenarios.D_ENTRY_SL = pass(
      channelOk(dEmail, dTg) && tpAfterSl === 0 ? 'PASS' : 'FAIL',
      { canonicalTradeId: d.uuid, slEventId: dSl.eventId, tpJobsAfter: tpAfterSl }
    );

    const eUuid = `stgcanary-${runId}-E`;
    const eBody = payload('entry', eUuid, user._id, tvUser);
    const first = await postWebhook(eBody);
    await waitJobs(DeliveryJob, { eventId: eBody.eventId, expectedDelivered });
    const second = await postWebhook(eBody);
    const eSignals = await Signal.countDocuments({
      $or: [{ signalUuid: eUuid }, { canonicalTradeId: eUuid }]
    });
    const eJobs = await DeliveryJob.countDocuments({
      canonicalTradeId: eUuid,
      channel: { $in: ['email', 'telegram'] },
      state: 'delivered'
    });
    scenarios.E_DUPLICATE_WEBHOOK = pass(
      eSignals <= 1 && eJobs === expectedDelivered ? 'PASS' : 'FAIL',
      {
        signals: eSignals,
        deliveredJobs: eJobs,
        expectedDelivered,
        firstHttp: first.httpStatus,
        secondHttp: second.httpStatus,
        secondAccepted: second.json && second.json.accepted
      }
    );

    scenarios.F_CHANNEL_INDEPENDENCE = pass(
      'BLOCKED',
      'No failure-injection hook (mailer.js / Telegram are protected).'
    );

    scenarios.G_REDIS = pass('PASS', 'Validated during health (SET NX, TTL, HASH) before matrix');
    scenarios.H_MONGODB = pass(signalIsEntry && overlayOk ? 'PASS' : 'FAIL', {
      database: requiredDatabase,
      entrySignalPersisted: Boolean(a.signal),
      overlay: 'Mongo Signal remains ENTRY; TP1 DeliveryJob.eventType stays TP1'
    });
    scenarios.I_PROCESS_RECOVERY = pass(
      'BLOCKED',
      requiredDatabase === REQUIRED_STAGING_DB
        ? 'Not auto-run. Operator may restart ONLY kaching-api-staging.'
        : 'Not auto-run. Operator may restart the local Node process only.'
    );
    scenarios.J_ADMIN_OBSERVABILITY = pass(
      'BLOCKED',
      'fanout_complete != all channels delivered (AdminPipeline.jsx). Live Admin not part of this run.'
    );

    return { executed: true, scenarios, jobs: jobsOut, subscriberId: String(user._id) };
  } finally {
    try {
      await DeliveryJob.deleteMany({ canonicalTradeId: new RegExp(`^stgcanary-${runId}`) });
      await Signal.deleteMany({
        $or: [
          { signalUuid: new RegExp(`^stgcanary-${runId}`) },
          { canonicalTradeId: new RegExp(`^stgcanary-${runId}`) }
        ]
      });
      await UserConfig.deleteMany({ 'preferences.soakRunId': runId, 'preferences.stagingCanary': true });
    } catch {
      /* cleanup best-effort */
    }
    try {
      await mongoose.disconnect();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { runCanaryMatrix };
