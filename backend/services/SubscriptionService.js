const UserConfig = require('../models/User');
const PaymentTransaction = require('../models/PaymentTransaction');
const devUserStore = require('../utils/devUserStore');
const devPaymentStore = require('../utils/devPaymentStore');
const { sanitizeUser } = require('../utils/auth');

const SUBSCRIPTION_PERIOD_DAYS = 30;

function isDbReady() {
  const mongoose = require('mongoose');
  return mongoose.connection.readyState === 1;
}

async function activateSubscription(
  userId,
  { tier, provider, providerOrderId, providerCustomerId, billingCycle = 'monthly', periodDays },
  io
) {
  const normalizedCycle = billingCycle === 'weekly' ? 'weekly' : 'monthly';
  const days = periodDays || (normalizedCycle === 'weekly' ? 7 : SUBSCRIPTION_PERIOD_DAYS);
  const periodEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const subscription = {
    tier,
    status: 'active',
    provider,
    providerOrderId,
    providerCustomerId: providerCustomerId || undefined,
    billingCycle: normalizedCycle,
    current_period_end: periodEnd,
    updatedAt: new Date()
  };

  if (!isDbReady()) {
    const user = devUserStore.upsertUser(userId, { subscription });
    if (!user) {
      throw new Error('User not found');
    }
    if (io) {
      io.emit('subscription:updated', { userId: userId.toString(), subscription: user.subscription });
    }
    return user;
  }

  const user = await UserConfig.findByIdAndUpdate(
    userId,
    { subscription, updatedAt: new Date() },
    { new: true }
  );

  if (!user) {
    throw new Error('User not found');
  }

  if (io) {
    io.emit('subscription:updated', { userId: userId.toString(), subscription: user.subscription });
  }

  return user;
}

async function createPaymentTransaction(data) {
  if (!isDbReady()) {
    return devPaymentStore.createTransaction(data);
  }
  return PaymentTransaction.create(data);
}

async function completePaymentTransaction(providerReference, provider, options = {}) {
  if (!isDbReady()) {
    return devPaymentStore.completeTransaction(providerReference, provider, options);
  }
  const status = options.failureReason ? 'failed' : 'completed';
  const update = {
    status,
    rawPayload: options.rawPayload,
    completedAt: new Date()
  };
  if (options.failureReason) {
    update.failureReason = options.failureReason;
  }
  return PaymentTransaction.findOneAndUpdate({ providerReference, provider }, update, { new: true });
}

async function getPaymentStatus(providerReference, provider, userId) {
  if (!isDbReady()) {
    return devPaymentStore.findByReference(providerReference, provider, userId);
  }
  const query = { providerReference, provider };
  if (userId) {
    query.userId = userId;
  }
  return PaymentTransaction.findOne(query);
}

async function findPaymentByReference(providerReference, provider) {
  if (!isDbReady()) {
    return devPaymentStore.findByReference(providerReference, provider);
  }
  return PaymentTransaction.findOne({ providerReference, provider });
}

module.exports = {
  SUBSCRIPTION_PERIOD_DAYS,
  activateSubscription,
  createPaymentTransaction,
  completePaymentTransaction,
  getPaymentStatus,
  findPaymentByReference,
  sanitizeUser
};
