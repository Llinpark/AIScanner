const express = require('express');
const mongoose = require('mongoose');
const Signal = require('../models/Signal');
const requireAuth = require('../middleware/requireAuth');
const requireSubscription = require('../middleware/requireSubscription');
const requireTierFeature = require('../middleware/requireTierFeature');
const {
  historyCutoffDate,
  sanitizeSignalForTier,
  filterSignalsForTier,
  getTierFeatures
} = require('../utils/subscriptionAccess');
const { buildAnalytics } = require('../utils/signalOutcome');
const { escapeRegex } = require('../utils/security');

function createAnalyticsRouter({ inMemorySignals, isDbReady }) {
  const router = express.Router();

  router.get('/summary', requireAuth, requireSubscription, requireTierFeature('performanceDashboard'), async (req, res) => {
    try {
      const cutoff = historyCutoffDate(req.user.subscription);
      const raw = isDbReady()
        ? await Signal.find({ createdAt: { $gte: cutoff } }).sort({ createdAt: -1 }).limit(1000).lean()
        : inMemorySignals.filter(s => !s.createdAt || new Date(s.createdAt) >= cutoff);

      const filtered = filterSignalsForTier(raw, req.user.subscription);
      const analytics = buildAnalytics(filtered);

      res.json({
        ...analytics,
        historyDays: getTierFeatures(req.user.subscription).historyDays
      });
    } catch (error) {
      console.error('Analytics summary error:', error);
      res.status(500).json({ message: 'Unable to load analytics summary', error: error.message });
    }
  });

  router.get('/timeseries', requireAuth, requireSubscription, requireTierFeature('performanceDashboard'), async (req, res) => {
    try {
      const cutoff = historyCutoffDate(req.user.subscription);
      const raw = isDbReady()
        ? await Signal.find({ createdAt: { $gte: cutoff } }).sort({ createdAt: -1 }).limit(1000).lean()
        : inMemorySignals.filter(s => !s.createdAt || new Date(s.createdAt) >= cutoff);

      const filtered = filterSignalsForTier(raw, req.user.subscription);
      const { timeseries, equityCurve, patternStats } = buildAnalytics(filtered);

      res.json({ timeseries, equityCurve, patternStats });
    } catch (error) {
      console.error('Analytics timeseries error:', error);
      res.status(500).json({ message: 'Unable to load analytics timeseries', error: error.message });
    }
  });

  router.get('/history', requireAuth, requireSubscription, async (req, res) => {
    try {
      const {
        page = 1,
        limit = 20,
        symbol,
        direction,
        outcome,
        alertType,
        pattern
      } = req.query;

      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
      const cutoff = historyCutoffDate(req.user.subscription);
      const features = getTierFeatures(req.user.subscription);

      const filter = { createdAt: { $gte: cutoff } };
      if (symbol) filter.symbol = new RegExp(escapeRegex(String(symbol).replace('/', '')), 'i');
      if (direction) filter.direction = new RegExp(`^${escapeRegex(String(direction))}$`, 'i');
      if (outcome) filter.outcome = outcome;
      if (alertType) filter.alertType = alertType;
      if (pattern) filter.pattern = pattern;

      let raw = [];
      if (isDbReady()) {
        raw = await Signal.find(filter).sort({ createdAt: -1 }).limit(features.maxSignals * 3).lean();
      } else {
        raw = inMemorySignals.filter(s => {
          if (s.createdAt && new Date(s.createdAt) < cutoff) return false;
          if (symbol && !String(s.symbol).toLowerCase().includes(String(symbol).toLowerCase())) return false;
          if (direction && !String(s.direction).toLowerCase().includes(String(direction).toLowerCase())) return false;
          if (outcome && s.outcome !== outcome) return false;
          if (alertType && s.alertType !== alertType) return false;
          if (pattern && s.pattern !== pattern) return false;
          return true;
        });
      }

      const filtered = filterSignalsForTier(raw, req.user.subscription).map(s =>
        sanitizeSignalForTier(s, req.user.subscription)
      );

      const total = filtered.length;
      const start = (pageNum - 1) * pageSize;
      const signals = filtered.slice(start, start + pageSize);

      res.json({
        page: pageNum,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
        historyDays: features.historyDays,
        signals
      });
    } catch (error) {
      console.error('Signal history error:', error);
      res.status(500).json({ message: 'Unable to load signal history', error: error.message });
    }
  });

  return router;
}

module.exports = createAnalyticsRouter;
