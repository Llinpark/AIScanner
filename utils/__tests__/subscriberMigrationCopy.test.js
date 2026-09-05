/**
 * Subscriber migration copy — generated Pine + setup UI.
 * Does not claim old alerts auto-migrated.
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

describe('subscriber migration copy', () => {
  it('SCALP generated instructions name engine 3m, webhook 3m, viz-only, no auto-migrate', () => {
    const g = mint('scalping');
    const text = g.instructions.join('\n');
    assert.match(text, /engine 3m/i);
    assert.match(text, /authoritative webhook 3m/i);
    assert.match(text, /visualization-only/i);
    assert.match(text, /1\.6\.0/);
    assert.match(text, /do not auto-migrate|not migrated automatically/i);
    assert.match(text, /Any alert\(\) function call/);
    assert.match(text, /\{\{alert_message\}\}/);
    assert.match(text, /production webhook URL only after production is approved/i);
    assert.doesNotMatch(text, /automatically migrated|already migrated|no action required/i);
  });

  it('DAY generated instructions name engine 5m, webhook 5m, 15m viz-only', () => {
    const g = mint('daytrading');
    const text = g.instructions.join('\n');
    assert.match(text, /engine 5m/i);
    assert.match(text, /authoritative webhook 5m/i);
    assert.match(text, /15m/);
    assert.match(text, /visualization-only/i);
    assert.match(text, /1\.6\.0/);
    assert.match(text, /do not auto-migrate|not migrated automatically/i);
  });

  it('TradingView setup surfaces do not claim automatic alert migration', () => {
    const dashboard = readFrontend('components/TradingViewDashboard.jsx');
    const setup = readFrontend('components/TradingViewSetup.jsx');
    const arch = readFrontend('constants/strategyArchitecture.js');
    const blob = `${dashboard}\n${setup}\n${arch}`;
    assert.match(dashboard, /Pine 1\.6\.0/);
    assert.match(dashboard, /do not migrate automatically/i);
    assert.match(setup, /do(?:es)? not auto-migrate/i);
    assert.match(arch, /engine 3m/);
    assert.match(arch, /engine 5m/);
    assert.match(arch, /authoritative webhook 3m/);
    assert.match(arch, /authoritative webhook 5m/);
    assert.doesNotMatch(blob, /alerts have automatically migrated|already migrated for you/i);
  });
});
