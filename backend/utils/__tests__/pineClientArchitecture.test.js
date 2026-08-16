/**
 * Pine client versioning, capabilities, flags, registry, context, decision stubs.
 * Prep only — confirms no delivery/auth behaviour change when flags are OFF.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  PINE_CLIENT_VERSION,
  CURRENT_PINE_CAPABILITIES,
  COMPAT_MODE,
  parseCapabilities,
  negotiateCapabilities,
  normalizePineClientVersion,
  resolveCompatibilityMode,
  extractPineClientMeta,
  capabilitiesJsonLiteral
} = require('../PineClientVersion');

const {
  getFeatureFlags,
  isFeatureEnabled,
  setFeatureFlagOverrides,
  resetFeatureFlagsForTests,
  FLAG_KEYS
} = require('../FeatureFlags');

const {
  parseOptionalWebhookContext,
  attachOptionalContext
} = require('../PineWebhookContext');

const PineClientRegistry = require('../../services/PineClientRegistry');
const PineClientDecisionFramework = require('../../services/PineClientDecisionFramework');
const { buildSignalData, parseWebhookBody } = require('../../services/TradingViewAlertService');

const LEGACY_ENTRY = {
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
  message: 'test',
  licenseToken: 'kls_v1.test',
  tradingviewUsername: 'demo',
  broadcast: true,
  signalUuid: 'sig-legacy-1',
  gapTop: 2651,
  gapBottom: 2649
};

describe('PineClientVersion', () => {
  it('stamps current version and 1.2.1 capability set', () => {
    assert.equal(PINE_CLIENT_VERSION, '1.2.1');
    assert.deepEqual(CURRENT_PINE_CAPABILITIES, [
      'v1_payload',
      'sl_risk_v1',
      'replace_active_v1',
      'json_esc_v1',
      'canonical_tf_v1',
      'event_bridge_v1'
    ]);
    assert.equal(
      capabilitiesJsonLiteral(),
      '["v1_payload","sl_risk_v1","replace_active_v1","json_esc_v1","canonical_tf_v1","event_bridge_v1"]'
    );
  });

  it('treats missing version as Legacy Mode', () => {
    const c = resolveCompatibilityMode(null);
    assert.equal(c.mode, COMPAT_MODE.LEGACY);
    assert.equal(c.isLegacy, true);
    assert.equal(c.pineClientVersion, null);
  });

  it('treats unparseable version as Legacy Mode (never reject)', () => {
    const c = resolveCompatibilityMode('not-a-version');
    assert.equal(c.mode, COMPAT_MODE.LEGACY);
    assert.equal(c.isLegacy, true);
  });

  it('maps current stamp 1.2.0 to CURRENT mode', () => {
    const c = resolveCompatibilityMode('1.2.0');
    assert.equal(c.mode, COMPAT_MODE.CURRENT);
    assert.equal(c.isLegacy, false);
  });

  it('maps same-major 1.1.0 to CURRENT mode', () => {
    const c = resolveCompatibilityMode('1.1.0');
    assert.equal(c.mode, COMPAT_MODE.CURRENT);
    assert.equal(c.isLegacy, false);
  });

  it('maps same-major 1.0.0 to CURRENT (accepted Stable Pine v1 family)', () => {
    const c = resolveCompatibilityMode('1.0.0');
    assert.equal(c.mode, COMPAT_MODE.CURRENT);
    assert.equal(c.pineClientVersion, '1.0.0');
    assert.equal(c.isLegacy, false);
  });

  it('maps older major to LEGACY (still accepted)', () => {
    const c = resolveCompatibilityMode('0.9.0');
    assert.equal(c.mode, COMPAT_MODE.LEGACY);
    assert.equal(c.pineClientVersion, '0.9.0');
    assert.equal(c.isLegacy, true);
  });

  it('maps future major to FUTURE mode', () => {
    const c = resolveCompatibilityMode('2.0.0');
    assert.equal(c.mode, COMPAT_MODE.FUTURE);
  });

  it('parses capabilities from array, string, and JSON string', () => {
    assert.deepEqual(parseCapabilities(['v1_payload', 'factors_v1']), [
      'v1_payload',
      'factors_v1'
    ]);
    assert.deepEqual(parseCapabilities('v1_payload, factors_v1'), [
      'v1_payload',
      'factors_v1'
    ]);
    assert.deepEqual(parseCapabilities('["v1_payload","atr_context"]'), [
      'v1_payload',
      'atr_context'
    ]);
  });

  it('ignores unknown capabilities during negotiation', () => {
    const caps = negotiateCapabilities(['v1_payload', 'totally_unknown_cap', 'factors_v1']);
    assert.deepEqual(caps, ['v1_payload', 'factors_v1']);
  });

  it('extractPineClientMeta handles legacy and current payloads', () => {
    const legacy = extractPineClientMeta(LEGACY_ENTRY);
    assert.equal(legacy.mode, COMPAT_MODE.LEGACY);
    assert.equal(legacy.pineClientVersion, null);
    assert.deepEqual(legacy.capabilities, []);

    const current = extractPineClientMeta({
      ...LEGACY_ENTRY,
      pineClientVersion: '1.1.0',
      scriptGenerationId: 'abc123',
      generatedAt: '2026-08-07T00:00:00.000Z',
      capabilities: ['v1_payload', 'unknown_x']
    });
    assert.equal(current.mode, COMPAT_MODE.CURRENT);
    assert.equal(current.pineClientVersion, '1.1.0');
    assert.deepEqual(current.capabilities, ['v1_payload']);
    assert.deepEqual(current.unknownCapabilities, ['unknown_x']);
    assert.equal(current.scriptGenerationId, 'abc123');
  });

  it('normalizePineClientVersion accepts v-prefix and prerelease', () => {
    assert.equal(normalizePineClientVersion('v1.0.0'), '1.0.0');
    assert.equal(normalizePineClientVersion('1.0.0-prep'), '1.0.0-prep');
    assert.equal(normalizePineClientVersion(''), null);
  });
});

describe('FeatureFlags', () => {
  afterEach(() => {
    resetFeatureFlagsForTests();
  });

  it('defaults all flags OFF', () => {
    const flags = getFeatureFlags();
    for (const key of FLAG_KEYS) {
      assert.equal(flags[key], false, `${key} should default false`);
      assert.equal(isFeatureEnabled(key), false);
    }
  });

  it('supports test overrides without affecting unset keys from env defaults', () => {
    setFeatureFlagOverrides({ enableSmartScore: true });
    assert.equal(isFeatureEnabled('enableSmartScore'), true);
    assert.equal(isFeatureEnabled('enableDynamicTP'), false);
    resetFeatureFlagsForTests();
    assert.equal(isFeatureEnabled('enableSmartScore'), false);
  });
});

describe('PineWebhookContext', () => {
  it('returns empty object for legacy payloads', () => {
    assert.deepEqual(parseOptionalWebhookContext(LEGACY_ENTRY), {});
  });

  it('parses optional context fields when present', () => {
    const ctx = parseOptionalWebhookContext({
      atr14: '1.25',
      volatility: 0.4,
      htfBias: 'bullish',
      sweepQuality: 0.9,
      fvgSize: 0.15,
      trendStrength: 0.7,
      confidenceFactors: { sweep: true, fvg: true },
      hasEngulfing: 'true'
    });
    assert.equal(ctx.atr14, 1.25);
    assert.equal(ctx.volatility, 0.4);
    assert.equal(ctx.htfBias, 'bullish');
    assert.equal(ctx.sweepQuality, 0.9);
    assert.equal(ctx.fvgSize, 0.15);
    assert.equal(ctx.trendStrength, 0.7);
    assert.deepEqual(ctx.confidenceFactors, { sweep: true, fvg: true });
    assert.equal(ctx.hasEngulfing, true);
  });

  it('attachOptionalContext is additive and ignores absent fields', () => {
    const signal = { symbol: 'XAUUSD', confidence: 0.8 };
    attachOptionalContext(signal, LEGACY_ENTRY);
    assert.equal(signal.pineContext, undefined);

    attachOptionalContext(signal, { atr14: 2 });
    assert.equal(signal.pineContext.atr14, 2);
    assert.equal(signal.confidence, 0.8);
  });
});

describe('PineClientRegistry', () => {
  beforeEach(() => {
    PineClientRegistry.resetForTests();
  });

  it('stores generation metadata', async () => {
    const snap = await PineClientRegistry.recordGeneration('user-1', {
      pineClientVersion: '1.0.0',
      scriptGenerationId: 'gen-1',
      scriptId: 'scr-1',
      strategy: 'scalping',
      generatedAt: '2026-08-07T12:00:00.000Z',
      capabilities: ['v1_payload']
    });
    assert.equal(snap.pineClientVersion, '1.0.0');
    assert.equal(snap.scriptGenerationId, 'gen-1');
    assert.deepEqual(snap.capabilities, ['v1_payload']);

    const got = PineClientRegistry.getEntry('user-1');
    assert.equal(got.scriptId, 'scr-1');
  });

  it('stores last webhook version without requiring version fields', async () => {
    await PineClientRegistry.recordWebhookVersion('user-2', LEGACY_ENTRY);
    const got = PineClientRegistry.getEntry('user-2');
    assert.equal(got.lastWebhookVersion, null);
    assert.ok(got.lastWebhookAt);

    await PineClientRegistry.recordWebhookVersion('user-2', {
      ...LEGACY_ENTRY,
      pineClientVersion: '1.0.0',
      capabilities: ['v1_payload']
    });
    const updated = PineClientRegistry.getEntry('user-2');
    assert.equal(updated.lastWebhookVersion, '1.0.0');
    assert.deepEqual(updated.lastWebhookCapabilities, ['v1_payload']);
  });

  it('never throws on missing userId', async () => {
    const r = await PineClientRegistry.recordWebhookVersion(null, LEGACY_ENTRY);
    assert.equal(r, null);
  });
});

describe('PineClientDecisionFramework', () => {
  afterEach(() => {
    resetFeatureFlagsForTests();
  });

  it('evaluateEntryDecision always proceeds for legacy payloads', () => {
    const signal = { ...LEGACY_ENTRY, confidence: 0.82 };
    const result = PineClientDecisionFramework.evaluateEntryDecision(LEGACY_ENTRY, signal);
    assert.equal(result.proceed, true);
    assert.equal(result.signalData.confidence, 0.82);
    assert.equal(result.context.client.mode, COMPAT_MODE.LEGACY);
  });

  it('pass-through when current version + flags OFF (no behaviour change)', () => {
    const body = {
      ...LEGACY_ENTRY,
      pineClientVersion: '1.1.0',
      capabilities: ['v1_payload']
    };
    const signal = {
      confidence: 0.9,
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
    assert.equal(result.context.client.mode, COMPAT_MODE.CURRENT);
    assert.deepEqual(result.applied, []);
    assert.equal(result.context.flags.enableSmartScore, false);
    assert.equal(result.context.flags.enableDynamicTP, false);
  });

  it('future major still proceeds (never reject; stubs do not filter)', () => {
    setFeatureFlagOverrides({
      enableAdaptiveTF: true,
      enableSmartScore: true,
      enableDynamicTP: true
    });
    const body = {
      ...LEGACY_ENTRY,
      pineClientVersion: '9.0.0',
      capabilities: ['v1_payload', 'mystery_cap']
    };
    const signal = { confidence: 0.77, entry: 10, stop_loss: 9, take_profit_1: 11 };
    const before = JSON.stringify(signal);
    const result = PineClientDecisionFramework.evaluateEntryDecision(body, signal);
    assert.equal(result.proceed, true);
    assert.equal(JSON.stringify(result.signalData), before);
    assert.equal(result.context.client.mode, COMPAT_MODE.FUTURE);
  });

  it('scoreConfidence / applyDynamicTakeProfits are no-ops while flags OFF', () => {
    const s = { confidence: 0.5, take_profit_1: 1 };
    assert.equal(PineClientDecisionFramework.scoreConfidence(s).confidence, 0.5);
    assert.equal(PineClientDecisionFramework.applyDynamicTakeProfits(s).take_profit_1, 1);
    const tf = PineClientDecisionFramework.applyAdaptiveTfPolicy(s);
    assert.equal(tf.allow, true);
  });
});

describe('TradingViewAlertService webhook compatibility', () => {
  it('buildSignalData accepts legacy payload without version fields', () => {
    const data = buildSignalData(LEGACY_ENTRY);
    assert.match(data.symbol, /XAU/);
    assert.equal(data.confidence, 0.82);
    assert.equal(data.pineCompatMode, COMPAT_MODE.LEGACY);
    assert.equal(data.pineClientVersion, undefined);
    assert.equal(data.entry, 2650.5);
    assert.equal(data.stop_loss, 2644);
    assert.equal(data.take_profit_1, 2663.5);
  });

  it('buildSignalData accepts current payload with additive version fields', () => {
    const data = buildSignalData({
      ...LEGACY_ENTRY,
      pineClientVersion: '1.1.0',
      scriptGenerationId: 'gen-xyz',
      generatedAt: '2026-08-07T01:00:00.000Z',
      capabilities: ['v1_payload'],
      atr14: 1.5
    });
    assert.equal(data.pineClientVersion, '1.1.0');
    assert.equal(data.scriptGenerationId, 'gen-xyz');
    assert.deepEqual(data.pineCapabilities, ['v1_payload']);
    assert.equal(data.pineCompatMode, COMPAT_MODE.CURRENT);
    assert.equal(data.pineContext.atr14, 1.5);
    // Existing required fields unchanged
    assert.equal(data.confidence, 0.82);
    assert.equal(data.take_profit_3, 2680);
  });

  it('unknown version still builds signal (never reject)', () => {
    const data = buildSignalData({
      ...LEGACY_ENTRY,
      pineClientVersion: '999.0.0',
      capabilities: 'mystery_cap,v1_payload'
    });
    assert.equal(data.pineCompatMode, COMPAT_MODE.FUTURE);
    assert.deepEqual(data.pineCapabilities, ['v1_payload']);
  });

  it('parseWebhookBody still merges nested message JSON', () => {
    const parsed = parseWebhookBody({
      message: JSON.stringify({ symbol: 'EURUSD', confidence: 0.5 })
    });
    assert.equal(parsed.symbol, 'EURUSD');
    assert.equal(parsed.confidence, 0.5);
  });
});
