/**
 * Subscriber setup copy — generated Pine + TradingView UI (Pine 1.3.0 / v155 era).
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { generateForUser } = require('../../services/PineScriptGeneratorService');

function mint(strategy) {
  process.env.TRADINGVIEW_WEBHOOK_SECRET =
    process.env.TRADINGVIEW_WEBHOOK_SECRET || 'smoke-test-tv-webhook-secret';
  process.env.WEBHOOK_SIGNING_SECRET =
    process.env.WEBHOOK_SIGNING_SECRET || 'smoke-test-license-signing-secret';
  return generateForUser(
    {
      _id: '507f1f77bcf86cd799439011',
      email: 'migrate@test.com',
      tradingviewUsername: 'demo_trader',
      subscription: { tier: 'professional', status: 'active' }
    },
    { strategy }
  );
}

function readFrontend(rel) {
  return fs.readFileSync(path.join(__dirname, '../../frontend/src', rel), 'utf8');
}

describe('subscriber setup copy', () => {
  it('SCALP instructions keep copy-paste scanner flow without viz-only authority copy', () => {
    const g = mint('scalping');
    const text = g.instructions.join('\n');
    assert.match(text, /1m, 3m, or 5m/);
    assert.match(text, /canonical 3m|canonical 3/);
    assert.match(text, /Any alert\(\) function call/);
    assert.match(text, /\{\{alert_message\}\}/);
    assert.doesNotMatch(text, /visualization-only/i);
    assert.doesNotMatch(text, /1\.6\.0/);
    assert.doesNotMatch(text, /must not have webhook alerts/i);
  });

  it('DAY instructions keep copy-paste scanner flow without viz-only authority copy', () => {
    const g = mint('daytrading');
    const text = g.instructions.join('\n');
    assert.match(text, /5m or 15m/);
    assert.match(text, /canonical 5m|canonical 5/);
    assert.doesNotMatch(text, /visualization-only/i);
    assert.doesNotMatch(text, /1\.6\.0/);
  });

  it('TradingView setup surfaces restore simple copy-paste flow', () => {
    const dashboard = readFrontend('components/TradingViewDashboard.jsx');
    const setup = readFrontend('components/TradingViewSetup.jsx');
    const arch = readFrontend('constants/strategyArchitecture.js');
    const blob = `${dashboard}\n${setup}\n${arch}`;
    assert.doesNotMatch(blob, /1\.6\.0/);
    assert.doesNotMatch(blob, /visualization-only/i);
    assert.doesNotMatch(blob, /authoritative webhook/i);
    assert.match(dashboard, /copy your personal Pine script/i);
    assert.match(arch, /Pine 1\.3\.0/);
    assert.match(arch, /Prefer ONE TradingView alert on canonical 3m/);
    assert.match(arch, /Prefer ONE TradingView alert on canonical 5m/);
  });
});
