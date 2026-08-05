const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireSubscription = require('../middleware/requireSubscription');
const requireTierFeature = require('../middleware/requireTierFeature');
const { createRateLimiter, clientKey } = require('../middleware/rateLimit');
const Mt5TradeCopierService = require('../services/Mt5TradeCopierService');
const Mt5PairingService = require('../services/Mt5PairingService');
const { PUBLIC_BACKEND_URL } = require('../config/appUrls');

/**
 * Header-only auth — never accept ?token= (leaks via access logs / Referer).
 * EA sends X-MT5-Token; Authorization: Bearer is also accepted.
 */
function extractMt5Token(req) {
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  return (
    req.headers['x-mt5-token'] ||
    req.headers['x-kaching-mt5-token'] ||
    bearer ||
    ''
  );
}

function pairCompleteHttpStatus(reason) {
  if (reason === 'pairing_unavailable') return 503;
  if (reason === 'rate_limited') return 429;
  if (reason === 'expired') return 410;
  if (reason === 'register_failed') return 500;
  return 400;
}

function bridgeAuthHttpStatus(reason) {
  return reason === 'access_expired' || reason === 'invalid_token' ? 401 : 401;
}

/** Pair-complete: coarse IP limiter (failed attempts also tracked in Mt5PairingService). */
const pairCompleteLimiter = createRateLimiter({
  windowMs: 10 * 60_000,
  max: 20,
  message: 'Too many pairing attempts. Wait and try a new Pair Code from the dashboard.'
});

/** Pair-start: avoid dashboard spam. */
const pairStartLimiter = createRateLimiter({
  windowMs: 10 * 60_000,
  max: 10,
  message: 'Too many pairing codes requested. Please wait a few minutes.'
});

function createMt5Router() {
  const router = express.Router();

  router.get('/status', requireAuth, requireSubscription, async (req, res) => {
    try {
      const status = await Mt5TradeCopierService.getPublicStatus(req.user);
      res.json({
        ...status,
        bridgeUrl: `${PUBLIC_BACKEND_URL}/api/mt5/bridge`
      });
    } catch (error) {
      console.error('MT5 status error:', error);
      res.status(500).json({ message: 'Unable to load MT5 auto trading status', error: error.message });
    }
  });

  /**
   * Dashboard: issue a short-lived 8-char PairCode (Redis TTL 10 min).
   * Never returns permanent tokens.
   */
  router.post(
    '/pair/start',
    requireAuth,
    requireSubscription,
    requireTierFeature('mt5Execution'),
    pairStartLimiter,
    async (req, res) => {
      try {
        const session = await Mt5PairingService.startPairing(req.userId);
        res.json({
          pairCode: session.pairCode,
          expiresAt: session.expiresAt,
          storage: session.storage,
          instructions: [
            'Compile and attach mt5/KachingTradeCopier.mq5 (or .ex5) v1.14+ on your MT5 terminal',
            `Allow WebRequest for ${PUBLIC_BACKEND_URL} under Tools → Options → Expert Advisors`,
            'Enter this 8-character Pair Code in the EA PairCode input',
            'Enable Algo Trading and attach the EA — it pairs once, then reconnects automatically',
            'You can pair multiple devices; revoke any device from Auto Trading without affecting others'
          ]
        });
      } catch (error) {
        if (error.code === 'PAIRING_UNAVAILABLE' || error.reason === 'pairing_unavailable') {
          return res.status(503).json({
            message: Mt5PairingService.PAIRING_UNAVAILABLE_MESSAGE,
            reason: 'pairing_unavailable'
          });
        }
        console.error('MT5 pair/start error:', error);
        res.status(500).json({ message: 'Unable to start MT5 pairing', error: error.message });
      }
    }
  );

  /**
   * EA: exchange PairCode for device-scoped access + refresh tokens (one-time).
   */
  router.post('/pair/complete', pairCompleteLimiter, async (req, res) => {
    try {
      const result = await Mt5PairingService.completePairing(req.body || {}, {
        ip: clientKey(req)
      });
      if (!result.ok) {
        return res.status(pairCompleteHttpStatus(result.reason)).json({
          message: result.message || 'Unable to complete pairing',
          reason: result.reason
        });
      }
      res.json({
        backendUrl: result.backendUrl,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        accessExpiresAt: result.accessExpiresAt,
        refreshExpiresAt: result.refreshExpiresAt,
        deviceId: result.deviceId,
        subscriberId: result.subscriberId,
        token: result.accessToken
      });
    } catch (error) {
      if (error.code === 'PAIRING_UNAVAILABLE' || error.reason === 'pairing_unavailable') {
        return res.status(503).json({
          message: Mt5PairingService.PAIRING_UNAVAILABLE_MESSAGE,
          reason: 'pairing_unavailable'
        });
      }
      console.error('MT5 pair/complete error:', error);
      res.status(500).json({ message: 'Unable to complete MT5 pairing', error: error.message });
    }
  });

  /** EA: renew access token using refresh token. */
  router.post('/pair/refresh', pairCompleteLimiter, async (req, res) => {
    try {
      const result = await Mt5PairingService.refreshAccessToken(req.body || {});
      if (!result.ok) {
        return res.status(401).json({
          message: result.message || 'Connection Lost — Please Pair Again',
          reason: result.reason
        });
      }
      res.json({
        accessToken: result.accessToken,
        accessExpiresAt: result.accessExpiresAt,
        deviceId: result.deviceId,
        token: result.accessToken
      });
    } catch (error) {
      console.error('MT5 pair/refresh error:', error);
      res.status(500).json({ message: 'Unable to refresh MT5 token', error: error.message });
    }
  });

  router.post(
    '/settings',
    requireAuth,
    requireSubscription,
    requireTierFeature('mt5Execution'),
    async (req, res) => {
      try {
        const mt5 = await Mt5TradeCopierService.updateSettings(req.userId, req.body || {});
        res.json({
          success: true,
          mt5,
          status: await Mt5TradeCopierService.getPublicStatus({ ...req.user, mt5 })
        });
      } catch (error) {
        console.error('MT5 settings error:', error);
        res.status(500).json({ message: 'Unable to update MT5 settings', error: error.message });
      }
    }
  );

  router.get(
    '/devices',
    requireAuth,
    requireSubscription,
    requireTierFeature('mt5Execution'),
    async (req, res) => {
      try {
        const devices = await Mt5TradeCopierService.listAuthorizedDevices(req.userId);
        res.json({ devices });
      } catch (error) {
        console.error('MT5 devices list error:', error);
        res.status(500).json({ message: 'Unable to list MT5 devices', error: error.message });
      }
    }
  );

  router.post(
    '/devices/:deviceId/revoke',
    requireAuth,
    requireSubscription,
    requireTierFeature('mt5Execution'),
    async (req, res) => {
      try {
        const result = await Mt5TradeCopierService.revokeDevice(req.userId, req.params.deviceId);
        if (!result.ok) {
          return res.status(404).json({ message: 'Device not found', reason: result.reason });
        }
        const devices = await Mt5TradeCopierService.listAuthorizedDevices(req.userId);
        const status = await Mt5TradeCopierService.getPublicStatus(req.user);
        res.json({
          ok: true,
          deviceId: result.deviceId,
          status: {
            ...status,
            devices,
            linked: devices.length > 0
          }
        });
      } catch (error) {
        console.error('MT5 device revoke error:', error);
        res.status(500).json({ message: 'Unable to revoke MT5 device', error: error.message });
      }
    }
  );

  router.get('/bridge/pending', async (req, res) => {
    try {
      const token = extractMt5Token(req);
      const result = await Mt5TradeCopierService.getPendingExecutions(token);
      if (!result.ok) {
        return res.status(bridgeAuthHttpStatus(result.reason)).json({
          message:
            result.reason === 'access_expired'
              ? 'Access token expired'
              : 'Invalid MT5 access token',
          reason: result.reason
        });
      }
      res.json({ trades: result.trades });
    } catch (error) {
      console.error('MT5 pending error:', error);
      res.status(500).json({ message: 'Unable to fetch pending trades', error: error.message });
    }
  });

  router.post('/bridge/sync', async (req, res) => {
    try {
      const token = extractMt5Token(req);
      const result = await Mt5TradeCopierService.syncAccountFromEa(token, req.body || {});
      if (!result.ok) {
        return res.status(bridgeAuthHttpStatus(result.reason)).json({
          message:
            result.reason === 'access_expired'
              ? 'Access token expired'
              : 'Invalid MT5 access token',
          reason: result.reason
        });
      }
      res.json({
        ok: true,
        accountBalance: result.mt5.accountBalance,
        accountCurrency: result.mt5.accountCurrency
      });
    } catch (error) {
      console.error('MT5 sync error:', error);
      res.status(500).json({ message: 'Unable to sync MT5 account', error: error.message });
    }
  });

  router.post('/bridge/heartbeat', async (req, res) => {
    try {
      const token = extractMt5Token(req);
      const result = await Mt5TradeCopierService.recordDeviceHeartbeat(
        token,
        req.body || {},
        { ip: clientKey(req) }
      );
      if (!result.ok) {
        return res.status(bridgeAuthHttpStatus(result.reason)).json({
          message:
            result.reason === 'access_expired'
              ? 'Access token expired'
              : 'Invalid MT5 access token',
          reason: result.reason
        });
      }
      res.json({ ok: true, deviceId: result.deviceId });
    } catch (error) {
      console.error('MT5 heartbeat error:', error);
      res.status(500).json({ message: 'Unable to record heartbeat', error: error.message });
    }
  });

  router.post('/bridge/report', async (req, res) => {
    try {
      const token = extractMt5Token(req);
      const result = await Mt5TradeCopierService.reportExecution(token, req.body || {});
      if (!result.ok) {
        const status =
          result.reason === 'invalid_token' || result.reason === 'access_expired'
            ? 401
            : result.reason === 'execution_not_found'
              ? 404
              : 400;
        return res.status(status).json({ message: 'Unable to report execution', reason: result.reason });
      }
      res.json({ ok: true, execution: result.execution });
    } catch (error) {
      console.error('MT5 report error:', error);
      res.status(500).json({ message: 'Unable to report execution', error: error.message });
    }
  });

  return router;
}

module.exports = createMt5Router;
