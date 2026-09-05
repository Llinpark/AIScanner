'use strict';

/**
 * Focused boot-safety test: Redis unavailable in the server.on('listening')
 * handler must not process.exit. HTTP is already listening; pairing stays fail-closed.
 *
 * Executes the real catch body from server.js with a fake process.exit.
 * Does not mutate global NODE_ENV / require.cache (node:test files run in parallel).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SERVER_PATH = path.join(__dirname, '..', '..', 'server.js');

function extractListeningRedisCatchBody() {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  const listeningIdx = src.indexOf("server.on('listening'");
  assert.ok(listeningIdx >= 0, "server.on('listening') not found");
  const catchMarker = 'Mt5PairingService.assertProductionRedisReady().catch(err => {';
  const catchIdx = src.indexOf(catchMarker, listeningIdx);
  assert.ok(catchIdx > listeningIdx, 'assertProductionRedisReady().catch not found in listening handler');
  const bodyStart = catchIdx + catchMarker.length;
  const after = src.slice(bodyStart);
  const endIdx = after.indexOf('\n    });\n  } catch (err) {');
  assert.ok(endIdx >= 0, 'could not bound Redis catch body in listening handler');
  return after.slice(0, endIdx);
}

function pairingUnavailableError(detail) {
  const err = new Error('MT5 Pairing is temporarily unavailable.');
  err.code = 'PAIRING_UNAVAILABLE';
  err.reason = 'pairing_unavailable';
  if (detail) err.detail = detail;
  return err;
}

function runCatch(body, err, nodeEnv) {
  let exitCode = null;
  const fakeProcess = {
    env: { NODE_ENV: nodeEnv },
    exit(code) {
      exitCode = code;
    }
  };
  const logs = [];
  const fakeConsole = {
    error: (...args) => logs.push(args.map(String).join(' ')),
    log: (...args) => logs.push(args.map(String).join(' ')),
    warn: (...args) => logs.push(args.map(String).join(' '))
  };
  const fn = new Function('err', 'process', 'console', body);
  fn(err, fakeProcess, fakeConsole);
  return { exitCode, logs: logs.join('\n') };
}

describe('production Redis boot degraded (listening handler)', () => {
  const body = extractListeningRedisCatchBody();

  it('does not process.exit when assert throws PAIRING_UNAVAILABLE in production', () => {
    const err = pairingUnavailableError('Redis unavailable at production startup');
    const { exitCode, logs } = runCatch(body, err, 'production');
    assert.equal(exitCode, null);
    assert.match(logs, /DEGRADED mode/);
    assert.match(logs, /MT5 pairing temporarily unavailable/);
  });

  it('does not process.exit when getRedisClient is null (Redis unavailable detail)', () => {
    const err = pairingUnavailableError('Redis unavailable at production startup');
    const { exitCode, logs } = runCatch(body, err, 'production');
    assert.equal(exitCode, null);
    assert.match(logs, /DEGRADED mode/);
  });

  it('does not process.exit when error message is Redis unavailable', () => {
    const err = new Error('Redis unavailable');
    const { exitCode, logs } = runCatch(body, err, 'production');
    assert.equal(exitCode, null);
    assert.match(logs, /DEGRADED mode/);
  });

  it('still process.exit(1) for unexpected non-Redis fatals in production', () => {
    const err = new Error("Cannot find module './services/UnexpectedBootModule'");
    err.code = 'MODULE_NOT_FOUND';
    const { exitCode } = runCatch(body, err, 'production');
    assert.equal(exitCode, 1);
  });
});
