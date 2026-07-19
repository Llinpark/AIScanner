const express = require('express');
const TradeJournal = require('../models/TradeJournal');
const devJournalStore = require('../utils/devJournalStore');
const requireAuth = require('../middleware/requireAuth');
const requireSubscription = require('../middleware/requireSubscription');
const requireTierFeature = require('../middleware/requireTierFeature');

const JOURNAL_PATCH_FIELDS = new Set([
  'symbol',
  'direction',
  'entry',
  'exit',
  'lotSize',
  'outcome',
  'outcomeR',
  'pnl',
  'notes',
  'tags',
  'signalId',
  'openedAt',
  'closedAt'
]);

function pickJournalPatch(body = {}) {
  const patch = {};
  for (const key of JOURNAL_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      patch[key] = body[key];
    }
  }
  patch.updatedAt = new Date();
  return patch;
}

function isDbReady() {
  const mongoose = require('mongoose');
  return mongoose.connection.readyState === 1;
}

function createJournalRouter() {
  const router = express.Router();

  router.use(requireAuth, requireSubscription, requireTierFeature('tradeJournal'));

  router.get('/', async (req, res) => {
    try {
      const userId = req.userId;
      if (isDbReady()) {
        const entries = await TradeJournal.find({ userId }).sort({ createdAt: -1 }).limit(200).lean();
        return res.json({ entries, count: entries.length });
      }
      const entries = devJournalStore.listByUser(userId);
      res.json({ entries, count: entries.length });
    } catch (error) {
      console.error('Journal list error:', error);
      res.status(500).json({ message: 'Unable to load trade journal', error: error.message });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const userId = req.userId;
      const { symbol, direction, entry, exit, lotSize, outcome, outcomeR, pnl, notes, tags, signalId, openedAt, closedAt } =
        req.body;

      if (!symbol || !direction) {
        return res.status(400).json({ message: 'symbol and direction are required' });
      }

      const payload = {
        symbol,
        direction,
        entry: entry != null ? Number(entry) : undefined,
        exit: exit != null ? Number(exit) : undefined,
        lotSize: lotSize != null ? Number(lotSize) : undefined,
        outcome: outcome || 'open',
        outcomeR: outcomeR != null ? Number(outcomeR) : undefined,
        pnl: pnl != null ? Number(pnl) : undefined,
        notes: notes || '',
        tags: Array.isArray(tags) ? tags : [],
        signalId: signalId || null,
        openedAt: openedAt ? new Date(openedAt) : new Date(),
        closedAt: closedAt ? new Date(closedAt) : undefined
      };

      if (isDbReady()) {
        const entryDoc = await TradeJournal.create({ userId, ...payload });
        return res.status(201).json({ entry: entryDoc });
      }

      const entryDoc = devJournalStore.create(userId, payload);
      res.status(201).json({ entry: entryDoc });
    } catch (error) {
      console.error('Journal create error:', error);
      res.status(500).json({ message: 'Unable to create journal entry', error: error.message });
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const userId = req.userId;
      const { id } = req.params;
      const patch = pickJournalPatch(req.body);

      if (isDbReady()) {
        const entry = await TradeJournal.findOneAndUpdate({ _id: id, userId }, { $set: patch }, { new: true });
        if (!entry) return res.status(404).json({ message: 'Journal entry not found' });
        return res.json({ entry });
      }

      const entry = devJournalStore.update(id, userId, patch);
      if (!entry) return res.status(404).json({ message: 'Journal entry not found' });
      res.json({ entry });
    } catch (error) {
      console.error('Journal update error:', error);
      res.status(500).json({ message: 'Unable to update journal entry', error: error.message });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const userId = req.userId;
      const { id } = req.params;

      if (isDbReady()) {
        const result = await TradeJournal.deleteOne({ _id: id, userId });
        if (!result.deletedCount) return res.status(404).json({ message: 'Journal entry not found' });
        return res.json({ success: true });
      }

      const ok = devJournalStore.remove(id, userId);
      if (!ok) return res.status(404).json({ message: 'Journal entry not found' });
      res.json({ success: true });
    } catch (error) {
      console.error('Journal delete error:', error);
      res.status(500).json({ message: 'Unable to delete journal entry', error: error.message });
    }
  });

  return router;
}

module.exports = createJournalRouter;
