const express = require('express');
const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const Signal = require('../models/Signal');
const PaymentTransaction = require('../models/PaymentTransaction');
const AdminAuditLog = require('../models/AdminAuditLog');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { sanitizeUser } = require('../utils/auth');
const { logAdminAction } = require('../utils/adminAudit');
const {
  buildSignalFilter,
  serializeSignal,
  findDuplicateEntries,
  dedupeEntries,
  closeStaleOpenEntries,
  applyManualOutcomeUpdate
} = require('../utils/adminSignals');
const MarketScannerService = require('../services/MarketScannerService');
const { activateSubscription, SUBSCRIPTION_PERIOD_DAYS } = require('../services/SubscriptionService');
const ReferralService = require('../services/ReferralService');
const { getScannerConfig, applyScannerConfig } = require('../utils/scannerRuntimeConfig');
const WeightLearningService = require('../services/WeightLearningService');
const { parseAdminEmails } = require('../utils/adminAccess');

const SUBSCRIPTION_TIERS = new Set(['basic', 'professional', 'premium']);
const SUBSCRIPTION_STATUSES = new Set(['inactive', 'pending', 'active', 'cancelled']);

function createAdminRouter({ io } = {}) {
  const router = express.Router();

  router.use(requireAuth, requireAdmin);

  router.get('/stats', async (req, res) => {
    try {
      const dbConnected = mongoose.connection.readyState === 1;
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      let userStats = { total: 0, activeSubscriptions: 0 };
      let signalStats = { total: 0, today: 0, openEntries: 0 };
      let paymentStats = { total: 0, completed: 0, failed: 0 };

      if (dbConnected) {
        const [
          total,
          activeSubscriptions,
          totalSignals,
          todaySignals,
          openSignals,
          totalPayments,
          completedPayments,
          failedPayments
        ] = await Promise.all([
          UserConfig.countDocuments(),
          UserConfig.countDocuments({ 'subscription.status': 'active' }),
          Signal.countDocuments(),
          Signal.countDocuments({ createdAt: { $gte: startOfDay } }),
          Signal.countDocuments({
            alertType: { $in: ['entry', 'signal'] },
            $or: [{ outcome: 'pending' }, { outcome: { $exists: false } }]
          }),
          PaymentTransaction.countDocuments(),
          PaymentTransaction.countDocuments({ status: 'completed' }),
          PaymentTransaction.countDocuments({ status: 'failed' })
        ]);

        userStats = { total, activeSubscriptions };
        signalStats = { total: totalSignals, today: todaySignals, openEntries: openSignals };
        paymentStats = { total: totalPayments, completed: completedPayments, failed: failedPayments };
      }

      const scannerStatus = MarketScannerService.getScannerStatus();
      const scannerConfig = getScannerConfig();

      res.json({
        dbConnected,
        users: userStats,
        signals: signalStats,
        payments: paymentStats,
        scanner: {
          ...scannerStatus,
          config: scannerConfig
        },
        adminEmailsConfigured: parseAdminEmails().length
      });
    } catch (error) {
      console.error('Admin stats error:', error);
      res.status(500).json({ message: 'Unable to load admin stats', error: error.message });
    }
  });

  router.get('/users', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const skip = (page - 1) * limit;
      const search = String(req.query.search || '').trim().toLowerCase();

      if (mongoose.connection.readyState !== 1) {
        return res.json({ users: [], page, limit, total: 0, pages: 0 });
      }

      const filter = search
        ? {
            $or: [
              { email: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
              { displayName: { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
            ]
          }
        : {};

      const [users, total] = await Promise.all([
        UserConfig.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        UserConfig.countDocuments(filter)
      ]);

      res.json({
        users: users.map(user => ({
          ...sanitizeUser(user),
          role: user.role || 'user'
        })),
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0
      });
    } catch (error) {
      console.error('Admin users error:', error);
      res.status(500).json({ message: 'Unable to load users', error: error.message });
    }
  });

  router.get('/users/:id', async (req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ message: 'Database unavailable.' });
      }

      const user = await UserConfig.findById(req.params.id).lean();
      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      res.json({
        user: {
          ...sanitizeUser(user),
          role: user.role || 'user',
          subscription: user.subscription || {}
        }
      });
    } catch (error) {
      console.error('Admin user detail error:', error);
      res.status(500).json({ message: 'Unable to load user', error: error.message });
    }
  });

  router.patch('/users/:id/subscription', async (req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ message: 'Database unavailable.' });
      }

      const user = await UserConfig.findById(req.params.id);
      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      const body = req.body || {};
      const subscription = { ...(user.subscription?.toObject?.() || user.subscription || {}) };
      let actionSummary = 'Updated subscription';

      if (body.tier && SUBSCRIPTION_TIERS.has(body.tier)) {
        subscription.tier = body.tier;
      }

      if (body.status && SUBSCRIPTION_STATUSES.has(body.status)) {
        subscription.status = body.status;
      }

      if (body.provider) {
        subscription.provider = body.provider;
      }

      if (body.activate === true) {
        subscription.status = 'active';
        subscription.tier = body.tier && SUBSCRIPTION_TIERS.has(body.tier) ? body.tier : subscription.tier || 'premium';
        subscription.provider = body.provider || subscription.provider || 'mock';
        const extendDays = Math.max(1, parseInt(body.extendDays, 10) || SUBSCRIPTION_PERIOD_DAYS);
        subscription.current_period_end = new Date(Date.now() + extendDays * 24 * 60 * 60 * 1000);
        actionSummary = `Activated ${subscription.tier} for ${extendDays} days`;
      } else if (body.extendDays) {
        const extendDays = Math.max(1, parseInt(body.extendDays, 10) || 0);
        const base = subscription.current_period_end && new Date(subscription.current_period_end) > new Date()
          ? new Date(subscription.current_period_end)
          : new Date();
        subscription.current_period_end = new Date(base.getTime() + extendDays * 24 * 60 * 60 * 1000);
        if (subscription.status !== 'active') {
          subscription.status = 'active';
        }
        actionSummary = `Extended subscription by ${extendDays} days`;
      }

      if (body.cancel === true) {
        subscription.status = 'cancelled';
        actionSummary = 'Cancelled subscription';
      }

      subscription.updatedAt = new Date();
      user.subscription = subscription;
      user.updatedAt = new Date();
      await user.save();

      if (io && subscription.status === 'active') {
        io.emit('subscription:updated', {
          userId: user._id.toString(),
          subscription: sanitizeUser(user).subscription
        });
      }

      await logAdminAction(req, {
        action: 'subscription.update',
        targetType: 'user',
        targetId: user._id.toString(),
        summary: `${actionSummary} for ${user.email}`,
        metadata: { subscription: sanitizeUser(user).subscription, request: body }
      });

      res.json({
        message: actionSummary,
        user: sanitizeUser(user)
      });
    } catch (error) {
      console.error('Admin subscription update error:', error);
      res.status(500).json({ message: 'Unable to update subscription', error: error.message });
    }
  });

  router.get('/signals', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const skip = (page - 1) * limit;

      if (mongoose.connection.readyState !== 1) {
        return res.json({ signals: [], page, limit, total: 0, pages: 0 });
      }

      const filter = buildSignalFilter(req.query);
      const [signals, total] = await Promise.all([
        Signal.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        Signal.countDocuments(filter)
      ]);

      res.json({
        signals: signals.map(serializeSignal),
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0
      });
    } catch (error) {
      console.error('Admin signals error:', error);
      res.status(500).json({ message: 'Unable to load signals', error: error.message });
    }
  });

  router.get('/signals/duplicates', async (req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) {
        return res.json({ duplicateGroups: [], duplicateCount: 0, scanned: 0 });
      }

      const limit = Math.min(10000, Math.max(100, parseInt(req.query.limit, 10) || 5000));
      const result = await findDuplicateEntries({ limit });
      res.json(result);
    } catch (error) {
      console.error('Admin duplicate preview error:', error);
      res.status(500).json({ message: 'Unable to analyze duplicates', error: error.message });
    }
  });

  router.post('/signals/dedupe', async (req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ message: 'Database unavailable.' });
      }

      const dryRun = req.body?.dryRun !== false;
      const limit = Math.min(10000, Math.max(100, parseInt(req.body?.limit, 10) || 5000));
      const result = await dedupeEntries({ dryRun, limit });

      await logAdminAction(req, {
        action: dryRun ? 'signals.dedupe.preview' : 'signals.dedupe.run',
        targetType: 'signal',
        summary: dryRun
          ? `Previewed ${result.duplicateCount} duplicate entries`
          : `Removed ${result.removed} duplicate entries`,
        metadata: result
      });

      res.json({
        message: dryRun
          ? `Found ${result.duplicateCount} duplicate entries across ${result.groups} groups.`
          : `Removed ${result.removed} duplicate entries.`,
        ...result
      });
    } catch (error) {
      console.error('Admin dedupe error:', error);
      res.status(500).json({ message: 'Unable to dedupe signals', error: error.message });
    }
  });

  router.post('/signals/close-stale', async (req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ message: 'Database unavailable.' });
      }

      const dryRun = req.body?.dryRun !== false;
      const olderThanDays = Math.max(1, parseInt(req.body?.olderThanDays, 10) || 30);
      const limit = Math.min(10000, Math.max(100, parseInt(req.body?.limit, 10) || 5000));
      const result = await closeStaleOpenEntries({ dryRun, olderThanDays, limit });

      await logAdminAction(req, {
        action: dryRun ? 'signals.close-stale.preview' : 'signals.close-stale.run',
        targetType: 'signal',
        summary: dryRun
          ? `Previewed ${result.matched} stale open entries`
          : `Closed ${result.closed} stale open entries`,
        metadata: result
      });

      res.json({
        message: dryRun
          ? `Found ${result.matched} open entries older than ${olderThanDays} days.`
          : `Closed ${result.closed} stale open entries.`,
        ...result
      });
    } catch (error) {
      console.error('Admin close stale error:', error);
      res.status(500).json({ message: 'Unable to close stale signals', error: error.message });
    }
  });

  router.patch('/signals/:id/outcome', async (req, res) => {
    try {
      if (mongoose.connection.readyState !== 1) {
        return res.status(503).json({ message: 'Database unavailable.' });
      }

      const signal = await Signal.findById(req.params.id);
      if (!signal) {
        return res.status(404).json({ message: 'Signal not found.' });
      }

      const outcome = String(req.body?.outcome || '').trim();
      const update = applyManualOutcomeUpdate(outcome);
      Object.assign(signal, update);
      await signal.save();

      try {
        WeightLearningService.scheduleRetrainOnOutcome(outcome);
      } catch (error) {
        console.error('Admin outcome learning schedule error:', error.message);
      }

      await logAdminAction(req, {
        action: 'signal.outcome.update',
        targetType: 'signal',
        targetId: signal._id.toString(),
        summary: `Set ${signal.symbol} outcome to ${outcome}`,
        metadata: { outcome, symbol: signal.symbol }
      });

      res.json({
        message: `Signal outcome updated to ${outcome}.`,
        signal: serializeSignal(signal.toObject())
      });
    } catch (error) {
      console.error('Admin signal outcome error:', error);
      res.status(error.message === 'Invalid outcome value.' ? 400 : 500).json({
        message: error.message === 'Invalid outcome value.' ? error.message : 'Unable to update signal outcome',
        error: error.message
      });
    }
  });

  router.get('/payments', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const skip = (page - 1) * limit;
      const status = String(req.query.status || '').trim();

      if (mongoose.connection.readyState !== 1) {
        return res.json({ payments: [], page, limit, total: 0, pages: 0 });
      }

      const filter = {};
      if (status) {
        filter.status = status;
      }

      const [payments, total] = await Promise.all([
        PaymentTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        PaymentTransaction.countDocuments(filter)
      ]);

      const userIds = [...new Set(payments.map(payment => String(payment.userId)).filter(Boolean))];
      const users = userIds.length
        ? await UserConfig.find({ _id: { $in: userIds } }).select('email displayName').lean()
        : [];
      const userMap = new Map(users.map(user => [user._id.toString(), user]));

      res.json({
        payments: payments.map(payment => ({
          id: payment._id.toString(),
          userId: payment.userId?.toString(),
          userEmail: userMap.get(String(payment.userId))?.email || null,
          tier: payment.tier,
          provider: payment.provider,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          providerReference: payment.providerReference,
          failureReason: payment.failureReason,
          createdAt: payment.createdAt,
          completedAt: payment.completedAt
        })),
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0
      });
    } catch (error) {
      console.error('Admin payments error:', error);
      res.status(500).json({ message: 'Unable to load payments', error: error.message });
    }
  });

  router.get('/audit-log', async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const skip = (page - 1) * limit;
      const action = String(req.query.action || '').trim();

      if (mongoose.connection.readyState !== 1) {
        return res.json({ entries: [], page, limit, total: 0, pages: 0 });
      }

      const filter = action ? { action: { $regex: action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {};

      const [entries, total] = await Promise.all([
        AdminAuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        AdminAuditLog.countDocuments(filter)
      ]);

      res.json({
        entries: entries.map(entry => ({
          id: entry._id.toString(),
          actorUserId: entry.actorUserId,
          actorEmail: entry.actorEmail,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          summary: entry.summary,
          metadata: entry.metadata,
          createdAt: entry.createdAt
        })),
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 0
      });
    } catch (error) {
      console.error('Admin audit log error:', error);
      res.status(500).json({ message: 'Unable to load audit log', error: error.message });
    }
  });

  router.get('/scanner/config', (req, res) => {
    res.json({
      config: getScannerConfig(),
      status: MarketScannerService.getScannerStatus()
    });
  });

  router.patch('/scanner/config', async (req, res) => {
    try {
      const updated = applyScannerConfig(req.body || {});

      if (io) {
        MarketScannerService.stopAutoScanner();
        if (updated.autoScanEnabled) {
          MarketScannerService.startAutoScanner(io);
        }
      }

      await logAdminAction(req, {
        action: 'scanner.config.update',
        targetType: 'scanner',
        summary: 'Updated scanner runtime configuration',
        metadata: updated
      });

      res.json({
        message: 'Scanner configuration updated.',
        config: updated,
        status: MarketScannerService.getScannerStatus(),
        note: 'Runtime changes apply until backend restart unless mirrored in backend/.env.'
      });
    } catch (error) {
      console.error('Admin scanner config error:', error);
      res.status(500).json({ message: 'Unable to update scanner config', error: error.message });
    }
  });

  router.get('/learning/status', async (req, res) => {
    try {
      const status = await WeightLearningService.getCurrentWeights();
      res.json({ status });
    } catch (error) {
      console.error('Admin learning status error:', error);
      res.status(500).json({ message: 'Unable to load learning status', error: error.message });
    }
  });

  router.get('/learning/weights', async (req, res) => {
    try {
      const status = await WeightLearningService.getCurrentWeights();
      res.json({
        pipeline: status.active?.pipeline,
        aiFactors: status.active?.aiFactors,
        defaults: status.defaults,
        history: status.history || [],
        lastRunAt: status.lastRunAt,
        lastResult: status.lastResult
      });
    } catch (error) {
      console.error('Admin learning weights error:', error);
      res.status(500).json({ message: 'Unable to load learned weights', error: error.message });
    }
  });

  router.post('/learning/retrain', async (req, res) => {
    try {
      const result = await WeightLearningService.retrain({
        limit: req.body?.limit ? Number(req.body.limit) : undefined
      });

      await logAdminAction(req, {
        action: 'learning.retrain',
        targetType: 'learning',
        summary: result.skipped
          ? `Weight retrain skipped (${result.pipeline?.reason || result.reason || 'insufficient data'})`
          : 'Retrained scoring weights from closed signal outcomes',
        metadata: {
          ok: result.ok,
          skipped: result.skipped,
          pipelineSampleCount: result.pipeline?.sampleCount,
          aiFactorsSampleCount: result.aiFactors?.sampleCount,
          pipelineVersion: result.pipeline?.version,
          aiFactorsVersion: result.aiFactors?.version
        }
      });

      res.json({
        message: result.skipped
          ? 'Retrain completed with no weight updates (insufficient samples or already in flight).'
          : 'Retrain completed and weights applied where sample size allowed.',
        result
      });
    } catch (error) {
      console.error('Admin learning retrain error:', error);
      res.status(500).json({ message: 'Unable to retrain weights', error: error.message });
    }
  });

  router.get('/referrals', async (req, res) => {
    try {
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 25;
      const status = req.query.status ? String(req.query.status) : undefined;
      const result = await ReferralService.listAdminCommissions({ page, limit, status });
      res.json(result);
    } catch (error) {
      console.error('Admin referrals error:', error);
      res.status(500).json({ message: 'Unable to load referral commissions', error: error.message });
    }
  });

  router.patch('/referrals/:id/pay', async (req, res) => {
    try {
      const { payoutReference, adminNotes } = req.body || {};
      const commission = await ReferralService.markCommissionPaid(req.params.id, {
        adminUserId: req.userId,
        payoutReference: payoutReference ? String(payoutReference).trim() : null,
        adminNotes: adminNotes ? String(adminNotes).trim() : null
      });

      await logAdminAction(req, {
        action: 'referral.commission.pay',
        targetType: 'referral_commission',
        targetId: commission._id.toString(),
        summary: `Marked referral commission ${commission._id} as paid`,
        metadata: {
          payoutReference: commission.payoutReference,
          commissionAmount: commission.commissionAmount,
          currency: commission.currency
        }
      });

      res.json({
        message: 'Referral commission marked as paid.',
        commission: {
          id: commission._id.toString(),
          status: commission.status,
          paidAt: commission.paidAt,
          payoutReference: commission.payoutReference
        }
      });
    } catch (error) {
      console.error('Admin referral pay error:', error);
      const status = error.message === 'Referral commission not found' ? 404 : 400;
      res.status(status).json({ message: error.message || 'Unable to mark commission paid', error: error.message });
    }
  });

  return router;
}

module.exports = createAdminRouter;
