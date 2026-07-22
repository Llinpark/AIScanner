const crypto = require('crypto');
const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const PaymentTransaction = require('../models/PaymentTransaction');
const ReferralCommission = require('../models/ReferralCommission');
const { FRONTEND_URL } = require('../config/appUrls');
const { hasFullAccess, getEffectiveSubscription } = require('../utils/subscriptionAccess');

const FIRST_COMMISSION_RATE = Number(process.env.REFERRAL_COMMISSION_FIRST_RATE || 0.15);
const RENEWAL_COMMISSION_RATE = Number(process.env.REFERRAL_COMMISSION_RENEWAL_RATE || 0.05);

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function isActiveSubscriber(user) {
  if (hasFullAccess(user)) return true;
  return String(getEffectiveSubscription(user)?.status || '').toLowerCase() === 'active';
}

function normalizeReferralCode(code) {
  return String(code || '').trim().toUpperCase();
}

function generateReferralCodeCandidate() {
  return `KFX-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function maskEmail(email) {
  const normalized = String(email || '').trim();
  const [local, domain] = normalized.split('@');
  if (!local || !domain) return '—';
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

function roundMoney(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

async function findUserByReferralCode(code) {
  if (!isDbReady()) return null;
  const normalized = normalizeReferralCode(code);
  if (!normalized) return null;
  return UserConfig.findOne({ referralCode: normalized });
}

async function generateUniqueReferralCode() {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateReferralCodeCandidate();
    const existing = await UserConfig.findOne({ referralCode: candidate }).select('_id').lean();
    if (!existing) return candidate;
  }
  throw new Error('Unable to generate referral code.');
}

async function ensureReferralCodeForUser(userId) {
  if (!isDbReady()) return null;
  const user = await UserConfig.findById(userId);
  if (!user || !isActiveSubscriber(user)) {
    return null;
  }
  if (user.referralCode) {
    return user.referralCode;
  }
  const referralCode = await generateUniqueReferralCode();
  const updated = await UserConfig.findByIdAndUpdate(
    userId,
    { referralCode, updatedAt: new Date() },
    { new: true }
  );
  return updated?.referralCode || referralCode;
}

async function attributeReferralAtRegistration(newUserId, referralCode) {
  if (!isDbReady() || !referralCode) return null;

  const normalized = normalizeReferralCode(referralCode);
  if (!normalized) return null;

  const referrer = await findUserByReferralCode(normalized);
  if (!referrer || !isActiveSubscriber(referrer)) {
    return null;
  }

  const referrerId = referrer._id.toString();
  if (referrerId === String(newUserId)) {
    return null;
  }

  const updated = await UserConfig.findOneAndUpdate(
    {
      _id: newUserId,
      referredBy: { $in: [null, undefined] }
    },
    {
      referredBy: referrer._id,
      referredAt: new Date(),
      updatedAt: new Date()
    },
    { new: true }
  );

  return updated;
}

async function countPriorCompletedPayments(userId, excludeTransactionId) {
  const query = {
    userId,
    status: 'completed'
  };
  if (excludeTransactionId) {
    query._id = { $ne: excludeTransactionId };
  }
  return PaymentTransaction.countDocuments(query);
}

async function recordCommissionFromPayment(transaction) {
  if (!isDbReady() || !transaction || transaction.status !== 'completed') {
    return null;
  }

  const paymentId = transaction._id || transaction.id;
  const referredUserId = transaction.userId;
  if (!paymentId || !referredUserId) {
    return null;
  }

  const existing = await ReferralCommission.findOne({ paymentTransactionId: paymentId });
  if (existing) {
    return existing;
  }

  const referredUser = await UserConfig.findById(referredUserId);
  if (!referredUser?.referredBy) {
    return null;
  }

  const referrer = await UserConfig.findById(referredUser.referredBy);
  if (!referrer || !isActiveSubscriber(referrer)) {
    return null;
  }

  const priorPayments = await countPriorCompletedPayments(referredUserId, paymentId);
  const commissionType = priorPayments === 0 ? 'first_subscription' : 'renewal';
  const commissionRate =
    commissionType === 'first_subscription' ? FIRST_COMMISSION_RATE : RENEWAL_COMMISSION_RATE;
  const commissionAmount = roundMoney(Number(transaction.amount || 0) * commissionRate);

  if (commissionAmount <= 0) {
    return null;
  }

  return ReferralCommission.create({
    referrerUserId: referrer._id,
    referredUserId: referredUser._id,
    paymentTransactionId: paymentId,
    commissionType,
    tier: transaction.tier,
    billingCycle: referredUser.subscription?.billingCycle === 'weekly' ? 'weekly' : 'monthly',
    planAmount: transaction.amount,
    currency: transaction.currency,
    commissionRate,
    commissionAmount,
    status: 'pending'
  });
}

function buildTotals(commissions) {
  const totals = {
    pending: {},
    paid: {}
  };

  for (const row of commissions) {
    const bucket = row.status === 'paid' ? totals.paid : totals.pending;
    const currency = row.currency || 'KES';
    bucket[currency] = roundMoney((bucket[currency] || 0) + Number(row.commissionAmount || 0));
  }

  return totals;
}

async function getReferrerDashboard(userId) {
  if (!isDbReady()) {
    return {
      eligible: false,
      message: 'Referrals require database connection.',
      referralCode: null,
      referralLink: null,
      rates: { first: FIRST_COMMISSION_RATE, renewal: RENEWAL_COMMISSION_RATE },
      totals: { pending: {}, paid: {} },
      referrals: [],
      commissions: []
    };
  }

  const user = await UserConfig.findById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  if (!isActiveSubscriber(user)) {
    return {
      eligible: false,
      message: 'Activate a subscription to unlock your referral link.',
      referralCode: user.referralCode || null,
      referralLink: null,
      rates: { first: FIRST_COMMISSION_RATE, renewal: RENEWAL_COMMISSION_RATE },
      totals: { pending: {}, paid: {} },
      referrals: [],
      commissions: []
    };
  }

  const referralCode = await ensureReferralCodeForUser(userId);
  const referralLink = `${FRONTEND_URL.replace(/\/$/, '')}/signup?ref=${encodeURIComponent(referralCode)}`;

  const [commissions, referredUsers] = await Promise.all([
    ReferralCommission.find({ referrerUserId: userId }).sort({ createdAt: -1 }).limit(100).lean(),
    UserConfig.find({ referredBy: userId }).select('email displayName subscription createdAt').lean()
  ]);

  const referredUserMap = new Map(referredUsers.map(entry => [entry._id.toString(), entry]));

  return {
    eligible: true,
    referralCode,
    referralLink,
    rates: { first: FIRST_COMMISSION_RATE, renewal: RENEWAL_COMMISSION_RATE },
    totals: buildTotals(commissions),
    referralCount: referredUsers.length,
    referrals: referredUsers.map(entry => ({
      id: entry._id.toString(),
      email: maskEmail(entry.email),
      displayName: entry.displayName || null,
      subscriptionStatus: entry.subscription?.status || 'inactive',
      tier: entry.subscription?.tier || 'basic',
      joinedAt: entry.createdAt
    })),
    commissions: commissions.map(row => ({
      id: row._id.toString(),
      referredUserEmail: maskEmail(referredUserMap.get(String(row.referredUserId))?.email),
      commissionType: row.commissionType,
      tier: row.tier,
      billingCycle: row.billingCycle,
      planAmount: row.planAmount,
      currency: row.currency,
      commissionRate: row.commissionRate,
      commissionAmount: row.commissionAmount,
      status: row.status,
      payoutReference: row.payoutReference,
      paidAt: row.paidAt,
      createdAt: row.createdAt
    }))
  };
}

async function listAdminCommissions({ page = 1, limit = 25, status } = {}) {
  if (!isDbReady()) {
    return { commissions: [], page, limit, total: 0, pages: 0 };
  }

  const safePage = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const skip = (safePage - 1) * safeLimit;
  const filter = {};
  if (status) {
    filter.status = status;
  }

  const [rows, total] = await Promise.all([
    ReferralCommission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    ReferralCommission.countDocuments(filter)
  ]);

  const userIds = [
    ...new Set(
      rows.flatMap(row => [String(row.referrerUserId), String(row.referredUserId)]).filter(Boolean)
    )
  ];
  const users = userIds.length
    ? await UserConfig.find({ _id: { $in: userIds } }).select('email displayName').lean()
    : [];
  const userMap = new Map(users.map(user => [user._id.toString(), user]));

  return {
    commissions: rows.map(row => ({
      id: row._id.toString(),
      referrerUserId: String(row.referrerUserId),
      referrerEmail: userMap.get(String(row.referrerUserId))?.email || null,
      referredUserId: String(row.referredUserId),
      referredUserEmail: userMap.get(String(row.referredUserId))?.email || null,
      paymentTransactionId: String(row.paymentTransactionId),
      commissionType: row.commissionType,
      tier: row.tier,
      billingCycle: row.billingCycle,
      planAmount: row.planAmount,
      currency: row.currency,
      commissionRate: row.commissionRate,
      commissionAmount: row.commissionAmount,
      status: row.status,
      payoutReference: row.payoutReference,
      adminNotes: row.adminNotes,
      paidAt: row.paidAt,
      createdAt: row.createdAt
    })),
    page: safePage,
    limit: safeLimit,
    total,
    pages: Math.ceil(total / safeLimit) || 0
  };
}

async function markCommissionPaid(commissionId, { adminUserId, payoutReference, adminNotes } = {}) {
  if (!isDbReady()) {
    throw new Error('Database unavailable');
  }

  const commission = await ReferralCommission.findById(commissionId);
  if (!commission) {
    throw new Error('Referral commission not found');
  }
  if (commission.status === 'paid') {
    return commission;
  }
  if (commission.status === 'cancelled') {
    throw new Error('Cancelled commissions cannot be marked paid.');
  }

  commission.status = 'paid';
  commission.paidAt = new Date();
  commission.paidByAdminId = adminUserId || null;
  commission.payoutReference = payoutReference || null;
  commission.adminNotes = adminNotes || null;
  commission.updatedAt = new Date();
  await commission.save();
  return commission;
}

module.exports = {
  FIRST_COMMISSION_RATE,
  RENEWAL_COMMISSION_RATE,
  normalizeReferralCode,
  findUserByReferralCode,
  ensureReferralCodeForUser,
  attributeReferralAtRegistration,
  recordCommissionFromPayment,
  getReferrerDashboard,
  listAdminCommissions,
  markCommissionPaid,
  maskEmail
};
