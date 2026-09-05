/**
 * Delivery slot: PROCESSING lease vs SUCCESS commit.
 *
 * claimDelivery acquires a recoverable processing lease (expires).
 * It is NOT a permanent "already delivered" flag.
 * commitDeliverySuccess is the only terminal success write, and must run
 * after provider success (Telegram ok / email ok).
 *
 * Crash after claim and before send → lease expires → retry.
 * Crash after provider success and before commit → at-least-once resend possible.
 */

const mongoose = require('mongoose');
const TradeEventStore = require('./tradeEventStore');
const DurableDelivery = require('./durableDelivery');
const { resolveCanonicalTradeId } = require('./tradeEventIdentity');

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

/** @type {Map<string, Set<string>>} */
const memory = new Map();

function deliveryKey(eventType, channel, subscriberId) {
  const ev = String(eventType || 'entry').toLowerCase();
  const ch = String(channel || 'unknown').toLowerCase();
  const sub = String(subscriberId || 'broadcast');
  return `${ev}:${ch}:${sub}`;
}

function signalKey(signalDoc) {
  return String(
    signalDoc?._id ||
      signalDoc?.id ||
      signalDoc?.signalUuid ||
      signalDoc?.signalId ||
      ''
  );
}

function memoryHas(id, key) {
  const set = memory.get(id);
  return Boolean(set && set.has(key));
}

function memoryAdd(id, key) {
  if (!memory.has(id)) memory.set(id, new Set());
  memory.get(id).add(key);
}

function specFrom(signalDoc, eventType, channel, subscriberId) {
  const canonicalTradeId =
    resolveCanonicalTradeId(signalDoc || {}) ||
    String(signalDoc?.signalUuid || signalDoc?.signalId || '').trim();
  const eventId = String(signalDoc?.eventId || canonicalTradeId || '').trim();
  return {
    eventId,
    canonicalTradeId,
    subscriberId: subscriberId || 'broadcast',
    channel,
    eventType: eventType || signalDoc?.alertType || 'entry',
    signalUuid: signalDoc?.signalUuid || signalDoc?.signalId || canonicalTradeId,
    signalDoc
  };
}

/**
 * PROCESSING claim. Returns true if this caller may send.
 * Returns false if already DELIVERED or another owner holds a live lease.
 */
async function claimDelivery(signalDoc, eventType, channel, subscriberId, opts = {}) {
  const spec = specFrom(signalDoc, eventType, channel, subscriberId);
  const id = signalKey(signalDoc);
  const key = deliveryKey(eventType, channel, subscriberId);

  if (id && memoryHas(id, key)) return false;

  const acquired = await DurableDelivery.beginAttempt(
    {
      ...spec,
      subscriber: opts.subscriber,
      telegramOptions: opts.telegramOptions
    },
    { owner: opts.owner }
  );

  if (acquired.status === 'delivered') {
    if (id) memoryAdd(id, key);
    return false;
  }
  if (acquired.status === 'provider_accepted') {
    await DurableDelivery.commitDeliveredBySpec(spec, { reason: 'provider_accepted_finish' });
    if (id) memoryAdd(id, key);
    return false;
  }
  if (acquired.status === 'acquired') return true;
  return false;
}

/**
 * SUCCESS commit — call only after provider success. Idempotent.
 */
async function commitDeliverySuccess(signalDoc, eventType, channel, subscriberId, extra = {}) {
  const spec = specFrom(signalDoc, eventType, channel, subscriberId);
  const id = signalKey(signalDoc);
  const key = deliveryKey(eventType, channel, subscriberId);
  if (id) memoryAdd(id, key);

  await DurableDelivery.commitDeliveredBySpec(spec, extra);

  if (!isDbConnected() || !id || String(id).startsWith('mem_')) {
    return true;
  }
  try {
    const Signal = require('../models/Signal');
    await Signal.findOneAndUpdate(
      { _id: id },
      { $addToSet: { deliveredKeys: key } },
      { new: true }
    );
  } catch (err) {
    console.warn('[deliveryIdempotency] success persist failed:', err.message);
  }
  return true;
}

async function recordDeliveryFailure(signalDoc, eventType, channel, subscriberId, opts = {}) {
  const spec = specFrom(signalDoc, eventType, channel, subscriberId);
  return DurableDelivery.scheduleRetryBySpec(spec, {
    reason: opts.reason,
    blockedWaitingForEntry: Boolean(opts.blockedWaitingForEntry)
  });
}

function resetForTests() {
  memory.clear();
  TradeEventStore.resetForTests();
}

module.exports = {
  deliveryKey,
  claimDelivery,
  commitDeliverySuccess,
  recordDeliveryFailure,
  specFrom,
  resetForTests
};
