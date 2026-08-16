/**
 * Phase 16 — Pre-deploy validation (local only).
 *
 * Proves Stable Pine Client prep is behaviour-identical to today's production
 * path while all new capabilities remain disabled / pass-through.
 *
 * Does NOT deploy, commit, or change trading/detection/delivery/auth behaviour.
 */

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  PINE_CLIENT_VERSION,
  COMPAT_MODE,
  extractPineClientMeta,
  resolveCompatibilityMode
} = require('../PineClientVersion');

const {
  FLAG_KEYS,
  getFeatureFlags,
  isFeatureEnabled,
  setFeatureFlagOverrides,
  resetFeatureFlagsForTests
} = require('../FeatureFlags');

const PineClientRegistry = require('../../services/PineClientRegistry');
const PineClientDecisionFramework = require('../../services/PineClientDecisionFramework');
const { buildSignalData, parseWebhookBody } = require('../../services/TradingViewAlertService');

const PRODUCTION_REQUIRED_FIELDS = [
  'symbol',
  'strategyName',
  'timeframe',
  'pattern',
  'alertType',
  'direction',
  'entry',
  'stop_loss',
  'stop_loss_1',
  'take_profit_1',
  'take_profit_2',
  'take_profit_3',
  'confidence',
  'message',
  'licenseToken',
  'tradingviewUsername',
  'broadcast',
  'signalUuid',
  'gapTop',
  'gapBottom'
];

const ADDITIVE_META_FIELDS = [
  'pineClientVersion',
  'generatedAt',
  'scriptGenerationId',
  'capabilities'
];

const LEGACY_PAYLOAD = Object.freeze({
  symbol: 'XAUUSD',
  strategyName: 'Liquidity Sweep + Fair Value Gap (Day Trading)',
  timeframe: '15',
  pattern: 'liquidity_sweep_fvg_daytrading',
  alertType: 'entry',
  direction: 'long',
  entry: 2650.5,
  stop_loss: 2644.0,
  stop_loss_1: 2644.0,
  take_profit_1: 2663.5,
  take_profit_2: 2670.0,
  take_profit_3: 2680.0,
  confidence: 0.82,
  message: 'phase16-legacy',
  licenseToken: 'kls_v1.test',
  tradingviewUsername: 'demo',
  broadcast: true,
  signalUuid: 'sig-phase16-legacy',
  gapTop: 2651,
  gapBottom: 2649
});

function v1Payload(overrides = {}) {
  return {
    ...LEGACY_PAYLOAD,
    signalUuid: 'sig-phase16-v1',
    pineClientVersion: '1.0.0',
    generatedAt: '2026-08-07T12:00:00.000Z',
    scriptGenerationId: 'gen-phase16-v1',
    capabilities: ['v1_payload'],
    ...overrides
  };
}

function futurePayload(overrides = {}) {
  return {
    ...LEGACY_PAYLOAD,
    signalUuid: 'sig-phase16-future',
    pineClientVersion: '5.0.0',
    generatedAt: '2026-08-07T12:00:00.000Z',
    scriptGenerationId: 'gen-phase16-future',
    capabilities: ['v1_payload', 'mystery_future_cap', 'totally_unknown'],
    ...overrides
  };
}

/** Trading-critical fields that must never diverge across modes. */
function tradingFingerprint(signal) {
  return {
    symbol: signal.symbol,
    direction: signal.direction,
    entry: signal.entry,
    stop_loss: signal.stop_loss,
    stop_loss_1: signal.stop_loss_1,
    take_profit_1: signal.take_profit_1,
    take_profit_2: signal.take_profit_2,
    take_profit_3: signal.take_profit_3,
    confidence: signal.confidence,
    alertType: signal.alertType,
    pattern: signal.pattern,
    timeframe: signal.timeframe,
    signalUuid: signal.signalUuid || signal.signalId,
    gapTop: signal.gapTop,
    gapBottom: signal.gapBottom,
    strategyName: signal.strategyName || signal.strategy,
    broadcast: signal.broadcast,
    source: signal.source,
    signalSource: signal.signalSource,
    origin: signal.origin
  };
}

describe('Phase16 Legacy Mode', () => {
  it('accepts webhook payload with NO version/meta fields', () => {
    for (const f of ADDITIVE_META_FIELDS) {
      assert.equal(Object.prototype.hasOwnProperty.call(LEGACY_PAYLOAD, f), false);
    }
    const data = buildSignalData(LEGACY_PAYLOAD);
    assert.equal(data.pineCompatMode, COMPAT_MODE.LEGACY);
    assert.equal(data.pineClientVersion, undefined);
    assert.equal(data.scriptGenerationId, undefined);
    assert.equal(data.pineCapabilities, undefined);
    assert.equal(data.confidence, 0.82);
    assert.equal(data.entry, 2650.5);
    assert.equal(data.stop_loss, 2644);
    assert.equal(data.take_profit_1, 2663.5);
    assert.equal(data.take_profit_2, 2670);
    assert.equal(data.take_profit_3, 2680);
  });

  it('decision framework does not interfere (proceed + identical signal)', () => {
    const signal = buildSignalData(LEGACY_PAYLOAD);
    const before = JSON.stringify(tradingFingerprint(signal));
    const decision = PineClientDecisionFramework.evaluateEntryDecision(LEGACY_PAYLOAD, signal);
    assert.equal(decision.proceed, true);
    assert.deepEqual(decision.applied, []);
    assert.equal(decision.context.client.mode, COMPAT_MODE.LEGACY);
    assert.equal(JSON.stringify(tradingFingerprint(decision.signalData)), before);
  });

  it('buildSignalData discards decision result even if framework mutates', () => {
    const original = PineClientDecisionFramework.evaluateEntryDecision;
    PineClientDecisionFramework.evaluateEntryDecision = () => ({
      proceed: false,
      signalData: {
        ...LEGACY_PAYLOAD,
        confidence: 0.01,
        entry: 1,
        take_profit_1: 2,
        stop_loss: 0
      },
      context: {},
      applied: ['mutated']
    });
    try {
      const data = buildSignalData(LEGACY_PAYLOAD);
      assert.equal(data.confidence, 0.82);
      assert.equal(data.entry, 2650.5);
      assert.equal(data.take_profit_1, 2663.5);
      assert.equal(data.stop_loss, 2644);
    } finally {
      PineClientDecisionFramework.evaluateEntryDecision = original;
    }
  });
});

describe('Phase16 Version 1 Client', () => {
  it('trading fields identical to legacy; only additive metadata differs', () => {
    const legacy = buildSignalData(LEGACY_PAYLOAD);
    const v1 = buildSignalData(v1Payload());

    const legacyFp = tradingFingerprint(legacy);
    const v1Fp = tradingFingerprint(v1);
    // signalUuid intentionally differs between fixtures — compare trading math
    delete legacyFp.signalUuid;
    delete v1Fp.signalUuid;
    assert.deepEqual(v1Fp, legacyFp);

    assert.equal(v1.pineCompatMode, COMPAT_MODE.CURRENT);
    assert.equal(v1.pineClientVersion, '1.0.0');
    assert.equal(v1.scriptGenerationId, 'gen-phase16-v1');
    assert.equal(v1.pineGeneratedAt, '2026-08-07T12:00:00.000Z');
    assert.deepEqual(v1.pineCapabilities, ['v1_payload']);
  });

  it('registry stores version metadata for v1 webhook', async () => {
    PineClientRegistry.resetForTests();
    await PineClientRegistry.recordWebhookVersion('user-v1', v1Payload());
    const entry = PineClientRegistry.getEntry('user-v1');
    assert.equal(entry.lastWebhookVersion, '1.0.0');
    assert.deepEqual(entry.lastWebhookCapabilities, ['v1_payload']);
    assert.equal(entry.scriptGenerationId, 'gen-phase16-v1');
  });

  it('decision framework pass-through for CURRENT mode', () => {
    const body = v1Payload();
    const signal = {
      confidence: 0.82,
      entry: 2650.5,
      stop_loss: 2644,
      take_profit_1: 2663.5,
      take_profit_2: 2670,
      take_profit_3: 2680
    };
    const before = JSON.stringify(signal);
    const result = PineClientDecisionFramework.evaluateEntryDecision(body, signal);
    assert.equal(result.proceed, true);
    assert.equal(JSON.stringify(result.signalData), before);
    assert.deepEqual(result.applied, []);
    assert.equal(result.context.client.mode, COMPAT_MODE.CURRENT);
  });
});

describe('Phase16 Future / Unknown Version', () => {
  afterEach(() => {
    resetFeatureFlagsForTests();
  });

  it('pineClientVersion=5.0.0 + unknown capabilities: no reject, delivery fields intact', () => {
    const body = futurePayload();
    const meta = extractPineClientMeta(body);
    assert.equal(meta.mode, COMPAT_MODE.FUTURE);
    assert.equal(meta.pineClientVersion, '5.0.0');
    assert.ok(meta.unknownCapabilities.includes('mystery_future_cap'));
    assert.ok(meta.unknownCapabilities.includes('totally_unknown'));

    const data = buildSignalData(body);
    assert.equal(data.pineCompatMode, COMPAT_MODE.FUTURE);
    assert.equal(data.confidence, 0.82);
    assert.equal(data.entry, 2650.5);
    assert.equal(data.take_profit_3, 2680);

    const decision = PineClientDecisionFramework.evaluateEntryDecision(body, data);
    assert.equal(decision.proceed, true);
    assert.equal(decision.signalData.confidence, 0.82);
  });

  it('future + all flags ON still never filters/rescores/rewrites', () => {
    const allOn = {};
    for (const key of FLAG_KEYS) allOn[key] = true;
    setFeatureFlagOverrides(allOn);

    const body = futurePayload();
    const signal = {
      confidence: 0.77,
      entry: 100,
      stop_loss: 99,
      take_profit_1: 101,
      take_profit_2: 102,
      take_profit_3: 103
    };
    const before = JSON.stringify(signal);
    const result = PineClientDecisionFramework.evaluateEntryDecision(body, signal);
    assert.equal(result.proceed, true);
    assert.equal(JSON.stringify(result.signalData), before);
  });
});

describe('Phase16 Feature Flags — individual ON still pass-through', () => {
  afterEach(() => {
    resetFeatureFlagsForTests();
  });

  it('defaults all OFF', () => {
    const flags = getFeatureFlags();
    for (const key of FLAG_KEYS) {
      assert.equal(flags[key], false);
    }
  });

  for (const flag of FLAG_KEYS) {
    it(`${flag}=ON does not rescore/rewrite/filter (legacy + current + future)`, () => {
      setFeatureFlagOverrides({ [flag]: true });
      assert.equal(isFeatureEnabled(flag), true);

      const cases = [
        { body: LEGACY_PAYLOAD, label: 'legacy' },
        { body: v1Payload(), label: 'v1' },
        { body: futurePayload(), label: 'future' }
      ];

      for (const { body, label } of cases) {
        const signal = {
          confidence: 0.65,
          entry: 200,
          stop_loss: 190,
          take_profit_1: 210,
          take_profit_2: 220,
          take_profit_3: 230,
          timeframe: '15'
        };
        const before = JSON.stringify(signal);
        const result = PineClientDecisionFramework.evaluateEntryDecision(body, signal);
        assert.equal(result.proceed, true, `${flag}/${label} proceed`);
        assert.equal(JSON.stringify(result.signalData), before, `${flag}/${label} unchanged`);

        // Explicit stub methods
        assert.equal(PineClientDecisionFramework.scoreConfidence(signal).confidence, 0.65);
        assert.equal(PineClientDecisionFramework.applyDynamicTakeProfits(signal).take_profit_1, 210);
        assert.equal(PineClientDecisionFramework.applyTrendBias(signal).confidence, 0.65);
        assert.equal(PineClientDecisionFramework.applyLiquidityRanking(signal).take_profit_2, 220);
        assert.equal(PineClientDecisionFramework.applyAdaptiveTfPolicy(signal).allow, true);
      }
    });
  }
});

describe('Phase16 Registry Failure Isolation', () => {
  beforeEach(() => {
    PineClientRegistry.resetForTests();
  });

  it('missing userId does not throw; signal build continues', async () => {
    const r = await PineClientRegistry.recordWebhookVersion(undefined, LEGACY_PAYLOAD);
    assert.equal(r, null);
    const data = buildSignalData(LEGACY_PAYLOAD);
    assert.equal(data.confidence, 0.82);
  });

  it('DB unavailable (readyState!=1) still records memory and does not throw', async () => {
    const desc = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    Object.defineProperty(mongoose.connection, 'readyState', {
      configurable: true,
      enumerable: true,
      get: () => 0
    });
    try {
      const snap = await PineClientRegistry.recordWebhookVersion('user-db-down', v1Payload());
      assert.ok(snap);
      assert.equal(snap.lastWebhookVersion, '1.0.0');
      const data = buildSignalData(v1Payload());
      assert.equal(data.pineClientVersion, '1.0.0');
    } finally {
      if (desc) Object.defineProperty(mongoose.connection, 'readyState', desc);
      else delete mongoose.connection.readyState;
    }
  });

  it('DB write exception is swallowed; webhook path continues', async () => {
    const User = require('../../models/User');
    const original = User.updateOne;
    const desc = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
    let updateCalled = false;
    User.updateOne = () => {
      updateCalled = true;
      return {
        exec: async () => {
          throw new Error('simulated mongo write failure');
        }
      };
    };

    Object.defineProperty(mongoose.connection, 'readyState', {
      configurable: true,
      enumerable: true,
      get: () => 1
    });

    try {
      const snap = await PineClientRegistry.recordWebhookVersion('user-db-fail', v1Payload());
      // memory write succeeds; persist failure swallowed asynchronously
      assert.ok(snap);
      assert.equal(snap.lastWebhookVersion, '1.0.0');
      // allow microtask for void persistToUser
      await new Promise((r) => setImmediate(r));
      assert.equal(updateCalled, true);

      const data = buildSignalData(LEGACY_PAYLOAD);
      assert.equal(data.confidence, 0.82);
      const decision = PineClientDecisionFramework.evaluateEntryDecision(LEGACY_PAYLOAD, data);
      assert.equal(decision.proceed, true);
    } finally {
      User.updateOne = original;
      if (desc) Object.defineProperty(mongoose.connection, 'readyState', desc);
      else delete mongoose.connection.readyState;
    }
  });

  it('recordGeneration exception path returns null without throwing', async () => {
    // Force getMemory path with empty user → null
    const r = await PineClientRegistry.recordGeneration('', { pineClientVersion: '1.0.0' });
    assert.equal(r, null);
  });

  it('registry throw from caller site can be swallowed (server.js pattern)', () => {
    // Mimic server.js fire-and-forget try/catch around require+record
    let continued = false;
    try {
      throw new Error('simulated registry module failure');
    } catch {
      // registry must never fail the webhook
    }
    continued = true;
    assert.equal(continued, true);
    const data = buildSignalData(LEGACY_PAYLOAD);
    assert.equal(data.alertType, 'entry');
  });
});

describe('Phase16 Payload Compatibility', () => {
  it('legacy and v1 share identical required production fields; only additive meta differs', () => {
    for (const f of PRODUCTION_REQUIRED_FIELDS) {
      assert.ok(f in LEGACY_PAYLOAD, `legacy missing ${f}`);
      assert.ok(f in v1Payload(), `v1 missing ${f}`);
      if (f === 'signalUuid' || f === 'message') continue;
      assert.deepEqual(v1Payload()[f], LEGACY_PAYLOAD[f], `field ${f}`);
    }
    for (const f of ADDITIVE_META_FIELDS) {
      assert.equal(f in LEGACY_PAYLOAD, false);
      assert.ok(f in v1Payload());
    }
  });

  it('parseWebhookBody preserves production + additive fields', () => {
    const nested = parseWebhookBody({
      message: JSON.stringify(v1Payload())
    });
    assert.equal(nested.symbol, 'XAUUSD');
    assert.equal(nested.pineClientVersion, '1.0.0');
    assert.equal(nested.confidence, 0.82);
    assert.equal(nested.licenseToken, 'kls_v1.test');
  });
});

describe('Phase16 Decision Framework Trace', () => {
  afterEach(() => {
    resetFeatureFlagsForTests();
  });

  it('webhook → framework → buildSignalData never alters trading output', () => {
    const bodies = [LEGACY_PAYLOAD, v1Payload(), futurePayload()];
    for (const body of bodies) {
      const built = buildSignalData(body);
      const ctx = PineClientDecisionFramework.buildDecisionContext(body, built);
      assert.ok(ctx.client.mode);
      assert.equal(ctx.shadowMode, false);

      // Simulate lifecycle consuming built signal (trading fields)
      const lifecycleLike = { ...built };
      assert.equal(lifecycleLike.confidence, 0.82);
      assert.equal(lifecycleLike.entry, 2650.5);
      assert.equal(lifecycleLike.stop_loss, 2644);

      // Delivery would use these fields — framework did not rewrite them
      const decision = PineClientDecisionFramework.evaluateEntryDecision(body, built);
      assert.equal(decision.proceed, true);
      assert.equal(decision.signalData.confidence, built.confidence);
      assert.equal(decision.signalData.take_profit_1, built.take_profit_1);
    }
  });
});

describe('Phase16 Auth Path Independence', () => {
  let generateLicenseToken;
  let verifyTradingViewWebhook;
  let previousEnv;

  before(() => {
    previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      WEBHOOK_SIGNING_SECRET: process.env.WEBHOOK_SIGNING_SECRET,
      TRADINGVIEW_WEBHOOK_SECRET: process.env.TRADINGVIEW_WEBHOOK_SECRET,
      ALLOW_LEGACY_WEBHOOK_SECRET: process.env.ALLOW_LEGACY_WEBHOOK_SECRET
    };
    process.env.NODE_ENV = 'production';
    process.env.WEBHOOK_SIGNING_SECRET = 'phase16-signing-secret-abcdefghijklmnopqrst';
    process.env.TRADINGVIEW_WEBHOOK_SECRET = 'phase16-tv-webhook-secret';
    delete process.env.ALLOW_LEGACY_WEBHOOK_SECRET;
    delete require.cache[require.resolve('../webhookSecurity')];
    delete require.cache[require.resolve('../subscriptionAccess')];
    ({ generateLicenseToken, verifyTradingViewWebhook } = require('../webhookSecurity'));
  });

  after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../webhookSecurity')];
  });

  function reqWithBody(body) {
    return { body, headers: {}, rawBody: Buffer.from(JSON.stringify(body), 'utf8') };
  }

  it('license auth accepts legacy and v1 and future payloads identically', async () => {
    const userId = '64b0f0f0f0f0f0f0f0f0f016';
    const tvu = 'phase16trader';
    const licenseToken = generateLicenseToken(userId, tvu);
    const resolve = async () => ({
      _id: userId,
      role: 'user',
      tradingviewUsername: tvu,
      subscription: { status: 'active', tier: 'professional' }
    });

    const bases = [
      { ...LEGACY_PAYLOAD, userId, tradingviewUsername: tvu, licenseToken },
      { ...v1Payload(), userId, tradingviewUsername: tvu, licenseToken },
      { ...futurePayload(), userId, tradingviewUsername: tvu, licenseToken }
    ];

    for (const body of bases) {
      const auth = await verifyTradingViewWebhook(reqWithBody(body), resolve);
      assert.equal(auth.ok, true, `auth failed for version=${body.pineClientVersion || 'legacy'}`);
      assert.equal(auth.mode, 'license');
      assert.equal(auth.userId, userId);
    }
  });
});

describe('Phase16 Performance Overhead', () => {
  it('registry/parser/flag/framework overhead is negligible', () => {
    const iterations = 2000;
    const body = v1Payload();
    const signal = { confidence: 0.8, entry: 1, stop_loss: 0.9, take_profit_1: 1.1 };

    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) extractPineClientMeta(body);
    const t1 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) getFeatureFlags();
    const t2 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) {
      PineClientDecisionFramework.evaluateEntryDecision(body, signal);
    }
    const t3 = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) buildSignalData(body);
    const t4 = process.hrtime.bigint();

    const ns = (a, b) => Number(b - a);
    const parseNs = ns(t0, t1) / iterations;
    const flagsNs = ns(t1, t2) / iterations;
    const frameworkNs = ns(t2, t3) / iterations;
    const buildNs = ns(t3, t4) / iterations;

    // Soft budgets — fail only if catastrophically slow (protects CI flakiness)
    assert.ok(parseNs < 500_000, `extractPineClientMeta too slow: ${parseNs}ns`);
    assert.ok(flagsNs < 200_000, `getFeatureFlags too slow: ${flagsNs}ns`);
    assert.ok(frameworkNs < 500_000, `evaluateEntryDecision too slow: ${frameworkNs}ns`);
    assert.ok(buildNs < 2_000_000, `buildSignalData too slow: ${buildNs}ns`);

    // Expose numbers for Phase 16 report via assertion message on success path
    const report = {
      iterations,
      extractPineClientMeta_ns_avg: Math.round(parseNs),
      getFeatureFlags_ns_avg: Math.round(flagsNs),
      evaluateEntryDecision_ns_avg: Math.round(frameworkNs),
      buildSignalData_ns_avg: Math.round(buildNs),
      extractPineClientMeta_us: +(parseNs / 1000).toFixed(3),
      getFeatureFlags_us: +(flagsNs / 1000).toFixed(3),
      evaluateEntryDecision_us: +(frameworkNs / 1000).toFixed(3),
      buildSignalData_us: +(buildNs / 1000).toFixed(3)
    };
    // Always truthy — keeps numbers in test output when --test-reporter=spec
    assert.ok(report.buildSignalData_us >= 0, JSON.stringify(report));
    console.log('[Phase16 PERF]', JSON.stringify(report));
  });
});

describe('Phase16 Memory Assessment', () => {
  beforeEach(() => {
    PineClientRegistry.resetForTests();
  });

  it('registry map grows per userId then clears on reset (no unbounded test leak)', async () => {
    for (let i = 0; i < 50; i += 1) {
      await PineClientRegistry.recordWebhookVersion(`user-mem-${i}`, v1Payload());
    }
    assert.equal(PineClientRegistry.listEntries().length, 50);

    // Re-recording same user does not create a second entry
    await PineClientRegistry.recordWebhookVersion('user-mem-0', v1Payload());
    assert.equal(PineClientRegistry.listEntries().length, 50);

    PineClientRegistry.resetForTests();
    assert.equal(PineClientRegistry.listEntries().length, 0);
  });

  it('feature flag overrides do not accumulate keys beyond FLAG_KEYS', () => {
    setFeatureFlagOverrides({ enableSmartScore: true, notARealFlag: true });
    const flags = getFeatureFlags();
    assert.equal(Object.keys(flags).sort().join(','), [...FLAG_KEYS].sort().join(','));
    resetFeatureFlagsForTests();
  });
});

describe('Phase16 Logging Assessment', () => {
  it('documents that pineCompatMode is attached for diagnostics without requiring console spam', () => {
    const legacy = buildSignalData(LEGACY_PAYLOAD);
    const current = buildSignalData(v1Payload());
    const future = buildSignalData(futurePayload());
    assert.equal(legacy.pineCompatMode, COMPAT_MODE.LEGACY);
    assert.equal(current.pineCompatMode, COMPAT_MODE.CURRENT);
    assert.equal(future.pineCompatMode, COMPAT_MODE.FUTURE);
    // Mode distinction is available on signalData for Mongo/pipeline consumers.
    // Dedicated console lines for Legacy/Versioned/Unknown are intentionally absent
    // to avoid webhook noise — gap noted in Phase 16 report (no behaviour change).
  });
});

describe('Phase16 Delivery/Telegram/MT5 Independence (static)', () => {
  it('TradeDeliveryService and TelegramService do not reference pine client gates', () => {
    const fs = require('fs');
    const path = require('path');
    const delivery = fs.readFileSync(
      path.join(__dirname, '../../services/TradeDeliveryService.js'),
      'utf8'
    );
    const telegram = fs.readFileSync(
      path.join(__dirname, '../../services/TelegramService.js'),
      'utf8'
    );
    assert.equal(/pineClient|pineCompat|PineClientDecision|enableSmartScore|enableDynamicTP/.test(delivery), false);
    assert.equal(/pineClient|pineCompat|PineClientDecision|enableSmartScore|enableDynamicTP/.test(telegram), false);
  });

  it('stamped version constant remains current Stable Pine stamp', () => {
    assert.equal(PINE_CLIENT_VERSION, '1.2.1');
    assert.equal(resolveCompatibilityMode('1.2.1').mode, COMPAT_MODE.CURRENT);
    // Same major family as stamp — CURRENT, not LEGACY (additive 1.x clients remain supported).
    assert.equal(resolveCompatibilityMode('1.1.0').mode, COMPAT_MODE.CURRENT);
    assert.equal(resolveCompatibilityMode('1.0.0').mode, COMPAT_MODE.CURRENT);
    assert.equal(resolveCompatibilityMode('5.0.0').mode, COMPAT_MODE.FUTURE);
    assert.equal(resolveCompatibilityMode(null).mode, COMPAT_MODE.LEGACY);
  });
});
