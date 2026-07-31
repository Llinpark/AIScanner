#!/usr/bin/env node
/**
 * Static guard: Pine Script forbids reassigning global scalars inside functions.
 * Array content mutation (push/set/clear) and *.delete() are allowed.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const P = require('../services/PineScriptGeneratorService');

const FORBIDDEN_GLOBALS = [
  'tradeState',
  'lineAge',
  'signalBar',
  'activeSignalId',
  'activeDirection',
  'activeEntry',
  'activeSl',
  'activeTp1',
  'activeTp2',
  'activeTp3',
  'activeGapTop',
  'activeGapBot',
  'tp1Done',
  'tp2Done',
  'tradeActive',
  'lbBadge',
  'fvgZone',
  'newTradeState',
  'newLineAge',
  'newTp1Done',
  'newTp2Done',
  'clearActiveScalars',
  'fvgBar',
  'dispBar',
  'licenseLockLabel'
];

const ASSIGN_RE = new RegExp(
  `\\b(${FORBIDDEN_GLOBALS.join('|')})\\s*(:=|\\+=|\\-=|\\*=|\\/=|%=)`
);

function extractFunctions(script) {
  const lines = script.split(/\r?\n/);
  const functions = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const def = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(.*\)\s*=>\s*(.*)$/);
    if (!def) {
      i += 1;
      continue;
    }
    const name = def[1];
    const inlineBody = def[2];
    const start = i + 1;
    // Single-line function: name() => expr
    if (inlineBody && inlineBody.trim().length > 0) {
      functions.push({ name, startLine: start, bodyLines: [inlineBody] });
      i += 1;
      continue;
    }
    // Indented multi-line body
    const bodyLines = [];
    let j = i + 1;
    while (j < lines.length) {
      const body = lines[j];
      if (body.trim() === '') {
        bodyLines.push(body);
        j += 1;
        continue;
      }
      // Function bodies in our templates are indented with 4 spaces.
      if (/^(\s{4}|\t)/.test(body)) {
        bodyLines.push(body);
        j += 1;
        continue;
      }
      break;
    }
    functions.push({ name, startLine: start, bodyLines });
    i = j;
  }
  return functions;
}

function validateScript(script, label) {
  const errors = [];
  if (!script.includes('//@version=6')) {
    errors.push(`${label}: expected //@version=6`);
  }
  if (script.includes('drawBuySignal(') || script.includes('drawSellSignal(')) {
    errors.push(`${label}: legacy drawBuySignal/drawSellSignal still referenced`);
  }
  if (!script.includes('tradeState') || !script.includes('lineAge')) {
    errors.push(`${label}: missing tradeState/lineAge state machine`);
  }
  if (!script.includes('armTradeDrawings(')) {
    errors.push(`${label}: missing armTradeDrawings helper`);
  }

  for (const fn of extractFunctions(script)) {
    fn.bodyLines.forEach((bodyLine, idx) => {
      const match = bodyLine.match(ASSIGN_RE);
      if (match) {
        errors.push(
          `${label}: function ${fn.name}() line ${fn.startLine + idx} assigns global '${match[1]}' via ${match[2]}`
        );
      }
    });
  }
  return errors;
}

function validateLocalArchive(errors) {
  const fs = require('fs');
  const path = require('path');
  const botPath = path.join(__dirname, '..', 'tradingview-bot.pine');
  const bot = fs.readFileSync(botPath, 'utf8');
  if (!bot.includes('//@version=6')) {
    errors.push('tradingview-bot.pine: expected //@version=6');
  }
  if (!bot.includes('tradeState') || !bot.includes('lineAge')) {
    errors.push('tradingview-bot.pine: missing tradeState/lineAge state machine');
  }
  for (const fn of extractFunctions(bot)) {
    fn.bodyLines.forEach((bodyLine, idx) => {
      const match = bodyLine.match(ASSIGN_RE);
      if (match) {
        errors.push(
          `tradingview-bot.pine: function ${fn.name}() line ${fn.startLine + idx} assigns global '${match[1]}' via ${match[2]}`
        );
      }
    });
  }
}

function main() {
  const user = {
    _id: '507f1f77bcf86cd799439011',
    email: 'pine-validate@test.com',
    tradingviewUsername: 'demo_trader',
    subscription: { tier: 'professional', status: 'active' }
  };

  const errors = [];
  for (const strategy of ['daytrading', 'scalping']) {
    const generated = P.generateForUser(user, { strategy });
    errors.push(...validateScript(generated.script, strategy));
  }
  validateLocalArchive(errors);

  if (errors.length) {
    console.error(JSON.stringify({ ok: false, errors }, null, 2));
    process.exit(1);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedStrategies: ['daytrading', 'scalping', 'tradingview-bot.pine'],
        forbiddenGlobals: FORBIDDEN_GLOBALS.length,
        note: 'No global scalar reassignments detected inside Pine functions'
      },
      null,
      2
    )
  );
}

main();
