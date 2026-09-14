/**
 * Kaching Pine chart drawing lifecycle (1.3.0).
 *
 * HARD PRODUCT RULE: no trade drawing may remain on TV when there is no active trade.
 * Completed trades may exist in Mongo/dashboard but MUST NOT stay visually on TV.
 *
 * Conceptual coverage A–M is encoded as static snippet + generated-Pine assertions.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { PINE_CLIENT_VERSION } = require('../PineClientVersion');

const SNIPPET_DIR = path.join(__dirname, '../../templates/snippets');
const TEMPLATE_DIR = path.join(__dirname, '../../templates');

const DRAW = fs.readFileSync(path.join(SNIPPET_DIR, 'kaching-trade-drawing.pine.snippet'), 'utf8');
const ARM = fs.readFileSync(path.join(SNIPPET_DIR, 'kaching-canon-event-arm.pine.snippet'), 'utf8');
const DRAW_RT = fs.readFileSync(
  path.join(SNIPPET_DIR, 'kaching-trade-drawing-runtime.pine.snippet'),
  'utf8'
);
const SCALP_TPL = fs.readFileSync(path.join(TEMPLATE_DIR, 'kaching-sweep-fvg-scalp.pine.template'), 'utf8');
const DAY_TPL = fs.readFileSync(
  path.join(TEMPLATE_DIR, 'kaching-sweep-fvg-daytrading.pine.template'),
  'utf8'
);

const RETENTION_RE =
  /MAX_COMPLETED_TRADES|\bdone(Entry|SL|TP\d*|LevelLines|LeaderLines|LevelLabels|Badges|Fvgs|Markers|LevelCounts|FvgCounts)\b|\bcompletedTrades\b|\barchivedTrades\b/;
const CHART_MARKER_RE = /"TP3 HIT"|"STOP LOSS"|"REPLACED"/;
const CLEANUP_CALL_RE =
  /cleanupActiveTradeDrawings\(tradeLevelLines,\s*tradeLeaderLines,\s*tradeLevelLabels,\s*tradeBadgeHold,\s*tradeFvgHold/;

function pineSources() {
  return [
    ['draw-engine', DRAW],
    ['event-arm', ARM],
    ['draw-runtime', DRAW_RT],
    ['scalp-template', SCALP_TPL],
    ['day-template', DAY_TPL]
  ];
}

describe('Kaching drawing lifecycle 1.3.0 (A–M)', () => {
  it('stamps Pine client 1.3.0 (drawing-lifecycle contract; users must regenerate)', () => {
    assert.equal(PINE_CLIENT_VERSION, '1.3.3');
  });

  it('D. retention arrays and MAX_COMPLETED_TRADES are gone from snippets/templates', () => {
    for (const [label, src] of pineSources()) {
      assert.doesNotMatch(src, RETENTION_RE, `${label}: leftover completed-trade retention`);
    }
  });

  it('G. cleanupActiveTradeDrawings is defined once and mutates via arguments', () => {
    const defs = DRAW.match(/^cleanupActiveTradeDrawings\(array<line>/m) || [];
    assert.equal(defs.length, 1, 'cleanup function must be defined once in the drawing engine');
    assert.match(DRAW, /array<line> levelLines/);
    assert.match(DRAW, /line\.delete\(array\.get\(levelLines/);
    assert.match(DRAW, /label\.delete\(array\.get\(levelLabels/);
    assert.match(DRAW, /label\.delete\(array\.get\(badges/);
    assert.match(DRAW, /box\.delete\(array\.get\(fvgs/);
    assert.match(DRAW, /array\.clear\(levelLines\)/);
    assert.match(DRAW, /array\.set\(flags, 0, 0\)/);
    assert.doesNotMatch(DRAW, /array\.(push|set|clear)\(\s*tradeLevelLines\b/);
  });

  it('A/E. no-active-trade leftover path deletes every drawing collection', () => {
    assert.match(DRAW_RT, /if tradeIsActive\(\)/);
    assert.match(DRAW_RT, /else if array\.size\(tradeLevelLines\) > 0/);
    assert.match(DRAW_RT, /array\.size\(tradeFvgHold\) > 0/);
    assert.match(DRAW_RT, CLEANUP_CALL_RE);
  });

  it('B/H. replace deletes all old objects before new drawings', () => {
    const replaceThenDraw = /cleanupActiveTradeDrawings\([\s\S]{0,400}label\.new\([\s\S]{0,200}Kaching Buy/;
    assert.match(ARM, replaceThenDraw);
    const cleanupCalls = ARM.match(/cleanupActiveTradeDrawings\(tradeLevelLines/g) || [];
    assert.equal(cleanupCalls.length, 3, 'arm: replace + terminal + safety-replace must each cleanup');
  });

  it('C/J/L. terminal order: closeNow → emitKachingEvent → cleanup (covers TP3, SL, expiry, same-bar)', () => {
    assert.match(ARM, /closeNow = hitSl or hitTp3 or expired/);
    const closeBlock = ARM.slice(ARM.indexOf('if closeNow'));
    const alertIdx = closeBlock.indexOf('emitKachingEvent(closeAlertType');
    const cleanupIdx = closeBlock.indexOf('cleanupActiveTradeDrawings(');
    assert.ok(alertIdx >= 0, 'terminal path must emitKachingEvent');
    assert.ok(cleanupIdx > alertIdx, 'cleanup must run after realtime-gated alert');
    assert.doesNotMatch(closeBlock.slice(0, 1200), CHART_MARKER_RE);
  });

  it('N. ENTRY arming bar does not score TP/SL (prevents same-second ENTRY+TP3)', () => {
    assert.match(ARM, /lifeT > entrySt/);
    assert.match(ARM, /array\.set\(tradeCanonMeta, 2, stEv\)/);
    assert.match(ARM, /array\.set\(tradeCanonMeta, 1, 1\)/);
    assert.match(ARM, /bar_index > tradeEntryBar\(\)/);
    assert.match(ARM, /bar_index != kachingEntryFlushBar/);
  });

  it('O. historical calc cannot consume webhook ids without alert/flush', () => {
    assert.match(ARM, /kachingPendingIds/);
    assert.match(ARM, /flushKachingPendingAlerts/);
    assert.match(ARM, /kachingSeenIds/);
    const emitFn = ARM.slice(ARM.indexOf('emitKachingEvent('));
    assert.match(emitFn, /alreadySeen/);
    assert.match(emitFn, /alreadyAlerted/);
  });

  it('P. hist pending queues ENTRY only; flush never emits TP with ENTRY', () => {
    assert.match(ARM, /kachingEntryFlushBar/);
    assert.match(ARM, /\(isEntry or isCancel\) and not kachingIdEmitted\(kachingPendingIds/);
    // Global assign must be outside the function (Pine v5).
    assert.match(ARM, /kachingEntryFlushBar := _kachingEntryFlushFromPending/);
    const flushFn = ARM.slice(ARM.indexOf('flushKachingPendingAlerts() =>'), ARM.indexOf('// Sole alert() gateway'));
    assert.match(flushFn, /str\.endswith\(pId, "\|ENTRY"\)/);
    assert.match(flushFn, /entryFlushBar := bar_index/);
    assert.doesNotMatch(flushFn, /kachingEntryFlushBar\s*:=/);
    assert.doesNotMatch(flushFn, /Pass 2: lifecycle/);
  });

  it('K. cancel/replacement and invalidation-equivalent leftover cleanup call the same function', () => {
    assert.match(ARM, /alertType=cancelled \| reason=new_confirmed_setup/);
    const cancelIdx = ARM.indexOf('emitKachingEvent("cancelled"');
    const cleanupAfterCancel = ARM.indexOf('cleanupActiveTradeDrawings(', cancelIdx);
    assert.ok(cancelIdx >= 0 && cleanupAfterCancel > cancelIdx);
    assert.match(ARM, /emitKachingEvent\("cancelled", tradeSignalId\(\), replMsg2/);
  });

  it('1. chart completion markers are not created', () => {
    for (const [label, src] of pineSources()) {
      assert.doesNotMatch(src, CHART_MARKER_RE, `${label}: completion/replace marker`);
    }
  });

  it('F. emitKachingEvent stays gated on barstate.isrealtime (not drawing retention)', () => {
    assert.match(ARM, /emitKachingEvent\(/);
    assert.match(ARM, /if barstate\.isrealtime/);
    assert.doesNotMatch(ARM, /isCanonicalAuthorityChart/);
    assert.doesNotMatch(ARM, /alertFiredAt = timenow/);
    assert.match(ARM, /kachingFireAlert\(payload\)/);
    assert.doesNotMatch(ARM, /if fireLong and barstate\.isrealtime/);
    assert.match(DRAW, /must not consume webhook ids|Historical calc may DRAW/i);
  });

  it('9. webhook URL, license token, and alert payload slots are unchanged', () => {
    assert.match(SCALP_TPL, /WEBHOOK_URL = "{{WEBHOOK_URL}}"/);
    assert.match(DAY_TPL, /WEBHOOK_URL = "{{WEBHOOK_URL}}"/);
    assert.match(SCALP_TPL, /LICENSE_TOKEN = str\.trim\("{{LICENSE_TOKEN}}"\)/);
    assert.match(DAY_TPL, /LICENSE_TOKEN = str\.trim\("{{LICENSE_TOKEN}}"\)/);
    assert.doesNotMatch(SCALP_TPL, /WEBHOOK_SIGNING_SECRET/);
    assert.doesNotMatch(DAY_TPL, /WEBHOOK_SIGNING_SECRET/);
  });
});

describe('Kaching drawing lifecycle — generated Pine', () => {
  it('M. generated scalping/daytrading scripts have zero retention refs and call cleanup on every terminal path', () => {
    process.env.TRADINGVIEW_WEBHOOK_SECRET =
      process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
    process.env.WEBHOOK_SIGNING_SECRET =
      process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';
    const { generateForUser } = require('../../services/PineScriptGeneratorService');
    const user = {
      _id: '507f1f77bcf86cd799439011',
      email: 't@test.com',
      tradingviewUsername: 'demo_trader',
      subscription: { tier: 'professional', status: 'active' }
    };
    for (const strategy of ['scalping', 'daytrading']) {
      const g = generateForUser(user, { strategy });
      assert.equal(g.pineClientVersion, '1.3.3', `${strategy} stamp`);
      assert.doesNotMatch(g.script, RETENTION_RE, `${strategy}: retention leftover`);
      assert.doesNotMatch(g.script, /"TP3 HIT"|"STOP LOSS"|"REPLACED"/, `${strategy}: chart marker leftover`);
      assert.match(g.script, /cleanupActiveTradeDrawings\(/);
      const calls = g.script.match(/cleanupActiveTradeDrawings\(tradeLevelLines/g) || [];
      assert.ok(calls.length >= 4, `${strategy}: replace + close + safety-replace + leftover runtime`);
      assert.match(g.script, /closeNow = hitSl or hitTp3 or expired/);
      assert.match(g.script, /emitKachingEvent\(/);
      assert.match(
        g.script,
        /if barstate\.isrealtime[\s\S]{0,400}kachingFireAlert\(payload\)/
      );
      assert.match(g.script, /flushKachingPendingAlerts|kachingPendingIds/);
      const code = g.script
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      assert.equal((code.match(/\balert\s*\(/g) || []).length, 1, `${strategy}: one alert() site`);
      assert.doesNotMatch(g.script, /alertFiredAt = timenow/);
      assert.match(g.script, /WEBHOOK_URL = "/);
      assert.match(g.script, /licenseToken/);
      assert.doesNotMatch(g.script, /WEBHOOK_SIGNING_SECRET/);
    }
  });
});
