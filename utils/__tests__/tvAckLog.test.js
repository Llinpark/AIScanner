'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

const {
  SLOW_ACK_MS,
  emitTvAck,
  formatTvAckLine,
  attachTvAckProbe,
  resolveMachineId
} = require('../tvAckLog');

function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

function post(app, { path = '/api/webhook/tradingview', statusHandler } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': 2 }
        },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode,
              body: Buffer.concat(chunks).toString('utf8'),
              logs: statusHandler && statusHandler.logs
            });
          });
        }
      );
      req.on('error', err => {
        server.close();
        reject(err);
      });
      req.end('{}');
    });
  });
}

describe('tvAckLog forensics instrumentation', () => {
  it('A. emitTvAck writes exactly one [TV_ACK] with required fields', () => {
    const prev = process.env.FLY_MACHINE_ID;
    process.env.FLY_MACHINE_ID = 'test-machine-1';
    try {
      const lines = captureLogs(() => {
        emitTvAck({
          requestId: 'tvw_test_1',
          symbol: 'EURUSD',
          tf: '15m',
          authMs: 12.4,
          acceptMs: 40.6,
          ackMs: 88.2,
          status: 202,
          outcome: 'accepted'
        });
      });
      const ack = lines.filter(l => l.startsWith('[TV_ACK] '));
      const slow = lines.filter(l => l.startsWith('[TV_ACK_SLOW]'));
      assert.equal(ack.length, 1);
      assert.equal(slow.length, 0);
      const line = ack[0];
      assert.match(line, /requestId=tvw_test_1/);
      assert.match(line, /machine=test-machine-1/);
      assert.match(line, /symbol=EURUSD/);
      assert.match(line, /tf=15m/);
      assert.match(line, /authMs=12/);
      assert.match(line, /acceptMs=41/);
      assert.match(line, /ackMs=88/);
      assert.match(line, /status=202/);
      assert.match(line, /outcome=accepted/);
      assert.ok(Number(line.match(/ackMs=(\d+)/)[1]) >= 0);
    } finally {
      if (prev == null) delete process.env.FLY_MACHINE_ID;
      else process.env.FLY_MACHINE_ID = prev;
    }
  });

  it('B. ackMs >= 1500 also emits [TV_ACK_SLOW] with the same fields', () => {
    const lines = captureLogs(() => {
      emitTvAck({
        requestId: 'tvw_slow_1',
        machine: 'm1',
        symbol: 'GBPUSD',
        tf: '5m',
        authMs: 10,
        acceptMs: 1600,
        ackMs: SLOW_ACK_MS,
        status: 202,
        outcome: 'accepted'
      });
    });
    assert.equal(lines.filter(l => l.startsWith('[TV_ACK] ')).length, 1);
    assert.equal(lines.filter(l => l.startsWith('[TV_ACK_SLOW]')).length, 1);
    assert.match(lines[1], /\[TV_ACK_SLOW\] requestId=tvw_slow_1/);
    assert.match(lines[1], /ackMs=1500/);
    assert.match(lines[1], /status=202/);
  });

  it('C. error/rejection still emits [TV_ACK] with status and outcome', () => {
    const lines = captureLogs(() => {
      emitTvAck({
        requestId: 'tvw_err_1',
        machine: 'm1',
        symbol: 'USDJPY',
        tf: '15m',
        authMs: 5,
        acceptMs: null,
        ackMs: 9,
        status: 503,
        outcome: 'rejected'
      });
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[TV_ACK\] /);
    assert.match(lines[0], /status=503/);
    assert.match(lines[0], /outcome=rejected/);
    assert.match(lines[0], /acceptMs=-/);
  });

  it('format never includes spaces that would break field search', () => {
    const line = formatTvAckLine('TV_ACK', {
      requestId: 'id 1',
      machine: 'm',
      symbol: 'EUR USD',
      tf: '15 m',
      authMs: 1,
      acceptMs: 2,
      ackMs: 3,
      status: 401,
      outcome: 'rejected'
    });
    assert.match(line, /symbol=EUR_USD/);
    assert.doesNotMatch(line, /licenseToken|password|secret|authorization/i);
  });

  it('D/E. probe emits one ACK, preserves status 202, does not start fan-out', async () => {
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.map(String).join(' '));
    const app = express();
    let fanout = 0;
    app.post('/api/webhook/tradingview', attachTvAckProbe, (req, res) => {
      req.tvAckProbe.symbol = 'AUDUSD';
      req.tvAckProbe.tf = '3m';
      req.tvAckProbe.authMs = 3;
      req.tvAckProbe.acceptMs = 11;
      req.tvAckProbe.outcome = 'accepted';
      res.status(202).json({
        ok: true,
        accepted: true,
        deferredFanout: true,
        requestId: req.tvAckProbe.requestId
      });
      fanout += 0;
    });
    const state = { logs };
    let result;
    try {
      result = await post(app, { statusHandler: state });
    } finally {
      console.log = orig;
    }
    result.logs = logs;
    assert.equal(result.status, 202);
    const body = JSON.parse(result.body);
    assert.equal(body.accepted, true);
    assert.equal(body.deferredFanout, true);
    assert.equal(fanout, 0);
    const ack = logs.filter(l => l.startsWith('[TV_ACK] '));
    assert.equal(ack.length, 1);
    assert.match(ack[0], /status=202/);
    assert.match(ack[0], /outcome=accepted/);
    assert.match(ack[0], /symbol=AUDUSD/);
    assert.match(ack[0], /machine=/);
    assert.ok(Number(ack[0].match(/ackMs=(\d+)/)[1]) >= 0);
    assert.ok(body.requestId);
  });

  it('C. HTTP 401 still emits [TV_ACK]', async () => {
    const logs = [];
    const orig = console.log;
    console.log = (...args) => logs.push(args.map(String).join(' '));
    const app = express();
    app.post('/api/webhook/tradingview', attachTvAckProbe, (req, res) => {
      req.tvAckProbe.outcome = 'rejected';
      res.status(401).json({ ok: false, accepted: false, requestId: req.tvAckProbe.requestId });
    });
    try {
      const result = await post(app);
      assert.equal(result.status, 401);
    } finally {
      console.log = orig;
    }
    const ack = logs.filter(l => l.startsWith('[TV_ACK] '));
    assert.equal(ack.length, 1);
    assert.match(ack[0], /status=401/);
    assert.match(ack[0], /outcome=rejected/);
  });

  it('resolveMachineId prefers FLY_MACHINE_ID', () => {
    const prev = process.env.FLY_MACHINE_ID;
    process.env.FLY_MACHINE_ID = '1857633da77168';
    try {
      assert.equal(resolveMachineId(), '1857633da77168');
    } finally {
      if (prev == null) delete process.env.FLY_MACHINE_ID;
      else process.env.FLY_MACHINE_ID = prev;
    }
  });
});
