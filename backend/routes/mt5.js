const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireSubscription = require('../middleware/requireSubscription');
const requireTierFeature = require('../middleware/requireTierFeature');
const Mt5TradeCopierService = require('../services/Mt5TradeCopierService');
const { PUBLIC_BACKEND_URL } = require('../config/appUrls');

function extractMt5Token(req) {
  return (
    req.headers['x-mt5-token'] ||
    req.headers['x-kaching-mt5-token'] ||
    req.query.token ||
    req.body?.token ||
    ''
  );
}

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
      res.status(500).json({ message: 'Unable to load MT5 trade copier status', error: error.message });
    }
  });

  router.post(
    '/link-token',
    requireAuth,
    requireSubscription,
    requireTierFeature('mt5Execution'),
    async (req, res) => {
      try {
        const link = await Mt5TradeCopierService.generateLinkToken(req.userId);
        res.json({
          token: link.token,
          bridgeUrl: `${PUBLIC_BACKEND_URL}/api/mt5/bridge`,
          instructions: [
            'Install KachingTradeCopier.ex5 on your MT5 terminal',
            `Set Backend URL to ${PUBLIC_BACKEND_URL}`,
            'Paste the link token into the EA inputs',
            'Enable Algo Trading in MT5',
            'The EA syncs your balance and executes trades when you tap Execute in Telegram'
          ]
        });
      } catch (error) {
        console.error('MT5 link-token error:', error);
        res.status(500).json({ message: 'Unable to generate MT5 link token', error: error.message });
      }
    }
  );

  router.post(
    '/settings',
    requireAuth,
    requireSubscription,
    requireTierFeature('mt5Execution'),
    async (req, res) => {
      try {
        const mt5 = await Mt5TradeCopierService.updateSettings(req.userId, req.body || {});
        res.json({ success: true, mt5, status: await Mt5TradeCopierService.getPublicStatus({ ...req.user, mt5 }) });
      } catch (error) {
        console.error('MT5 settings error:', error);
        res.status(500).json({ message: 'Unable to update MT5 settings', error: error.message });
      }
    }
  );

  router.get('/bridge/pending', async (req, res) => {
    try {
      const token = extractMt5Token(req);
      const result = await Mt5TradeCopierService.getPendingExecutions(token);
      if (!result.ok) {
        return res.status(401).json({ message: 'Invalid MT5 link token', reason: result.reason });
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
        return res.status(401).json({ message: 'Invalid MT5 link token', reason: result.reason });
      }
      res.json({ ok: true, accountBalance: result.mt5.accountBalance, accountCurrency: result.mt5.accountCurrency });
    } catch (error) {
      console.error('MT5 sync error:', error);
      res.status(500).json({ message: 'Unable to sync MT5 account', error: error.message });
    }
  });

  router.post('/bridge/report', async (req, res) => {
    try {
      const token = extractMt5Token(req);
      const result = await Mt5TradeCopierService.reportExecution(token, req.body || {});
      if (!result.ok) {
        const status = result.reason === 'invalid_token' ? 401 : 404;
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
