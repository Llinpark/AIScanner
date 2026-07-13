const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const requireSubscription = require('../middleware/requireSubscription');
const requireTierFeature = require('../middleware/requireTierFeature');
const TelegramService = require('../services/TelegramService');

function createTelegramRouter() {
  const router = express.Router();

  router.get('/status', requireAuth, requireSubscription, async (req, res) => {
    try {
      const status = await TelegramService.getPublicStatus(req.user);
      res.json(status);
    } catch (error) {
      console.error('Telegram status error:', error);
      res.status(500).json({ message: 'Unable to load Telegram status', error: error.message });
    }
  });

  router.post(
    '/link-code',
    requireAuth,
    requireSubscription,
    requireTierFeature('telegramAlerts'),
    async (req, res) => {
      try {
        if (!TelegramService.isConfigured()) {
          return res.status(503).json({
            message: 'Telegram bot is not configured on the server yet.'
          });
        }

        const link = await TelegramService.createLinkCode(req.userId);
        res.json({
          code: link.code,
          expiresAt: link.expiresAt,
          botUsername: link.botUsername,
          botUrl: TelegramService.getBotDeepLink(link.code),
          instructions: [
            `Open Telegram and search for @${link.botUsername}`,
            `Send: /link ${link.code}`,
            'Or tap the deep link below and press Start',
            'Code expires in 15 minutes'
          ]
        });
      } catch (error) {
        console.error('Telegram link-code error:', error);
        res.status(500).json({ message: 'Unable to generate Telegram link code', error: error.message });
      }
    }
  );

  router.post(
    '/unlink',
    requireAuth,
    requireSubscription,
    requireTierFeature('telegramAlerts'),
    async (req, res) => {
      try {
        await TelegramService.unlinkUser(req.userId);
        res.json({ success: true, message: 'Telegram account unlinked.' });
      } catch (error) {
        console.error('Telegram unlink error:', error);
        res.status(500).json({ message: 'Unable to unlink Telegram', error: error.message });
      }
    }
  );

  router.post('/toggle', requireAuth, requireSubscription, requireTierFeature('telegramAlerts'), async (req, res) => {
    try {
      const enabled = Boolean(req.body?.enabled);
      const telegram = {
        ...(req.user.telegram || {}),
        enabled
      };

      if (!telegram.chatId) {
        return res.status(400).json({ message: 'Link Telegram first before toggling alerts.' });
      }

      const mongoose = require('mongoose');
      const UserConfig = require('../models/User');
      const devUserStore = require('../utils/devUserStore');

      let user;
      if (mongoose.connection.readyState === 1) {
        user = await UserConfig.findByIdAndUpdate(
          req.userId,
          { telegram, updatedAt: new Date() },
          { new: true }
        );
      } else {
        user = devUserStore.upsertUser(req.userId, { telegram });
      }

      res.json({
        success: true,
        enabled,
        status: await TelegramService.getPublicStatus(user)
      });
    } catch (error) {
      console.error('Telegram toggle error:', error);
      res.status(500).json({ message: 'Unable to update Telegram alert preference', error: error.message });
    }
  });

  return router;
}

module.exports = createTelegramRouter;
