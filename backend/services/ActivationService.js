/**
 * ActivationService — single path from completed Payment → active Subscription.
 *
 * SEPARATION:
 *   PaymentTransaction = money received (audit)
 *   User.subscription  = access
 *
 * Scanner / Telegram / email alerts / premium APIs must only check subscription ACTIVE
 * (status === 'active'). Never query payments for access.
 *
 * Future gateways (Daraja / Stripe / PayPal webhooks): mark Payment completed, then call
 * activateFromCompletedPayment(payment, { io }).
 */

const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const PaymentTransaction = require('../models/PaymentTransaction');
const { sanitizeUser } = require('../utils/auth');
const { normalizeBillingCycle, getTierPricing, TIER_DISPLAY_NAMES } = require('../config/subscriptions');
const { logAdminAction } = require('../utils/adminAudit');
const { sendSubscriptionActivatedEmail } = require('../utils/mailer');

const SUBSCRIPTION_PERIOD_DAYS = 30;

const PAYMENT_SOURCE_BY_METHOD = {
  manual_mpesa: 'MANUAL_MPESA',
  manual_binance: 'MANUAL_BINANCE',
  mpesa: 'DARAJA',
  daraja: 'DARAJA',
  stripe: 'STRIPE',
  paypal: 'PAYPAL',
  bank: 'BANK',
  complimentary: 'ADMIN',
  binance: 'BINANCE',
  mock: 'MOCK',
  admin: 'ADMIN',
  beta: 'BETA'
};

const MANUAL_PROVIDERS = new Set(['manual_mpesa', 'manual_binance']);
const BINANCE_ID_DEFAULT = '484947783';
const MPESA_TILL_DEFAULT = '5337170';
const BUSINESS_NAME_DEFAULT = 'KachingFx Official';

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function remainingDaysFrom(expiryDate) {
  if (!expiryDate) return null;
  const ms = new Date(expiryDate).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

function normalizeMpesaCode(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function normalizeBinanceTxId(code) {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function normalizeManualMethod(method) {
  const key = String(method || 'manual_mpesa')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (key === 'binance' || key === 'manual_binance') return 'manual_binance';
  if (key === 'mpesa' || key === 'manual_mpesa' || key === 'manual') return 'manual_mpesa';
  return null;
}

function isManualPayment(payment) {
  const provider = String(payment?.provider || '').toLowerCase();
  const method = String(payment?.paymentMethod || '').toLowerCase();
  return MANUAL_PROVIDERS.has(provider) || MANUAL_PROVIDERS.has(method);
}

function mapPaymentSource(paymentMethodOrProvider) {
  const key = String(paymentMethodOrProvider || '').trim().toLowerCase();
  return PAYMENT_SOURCE_BY_METHOD[key] || 'ADMIN';
}

function resolvePeriodDays(billingCycle, explicitDays) {
  if (explicitDays != null && Number.isFinite(Number(explicitDays))) {
    return Math.max(1, parseInt(explicitDays, 10));
  }
  const cycle = normalizeBillingCycle(billingCycle);
  return cycle === 'yearly' ? 365 : SUBSCRIPTION_PERIOD_DAYS;
}

function serializeSubscription(subscription) {
  const raw = subscription?.toObject?.() || subscription || {};
  const expiry = raw.current_period_end || null;
  return {
    ...raw,
    startDate: raw.startDate || null,
    expiryDate: expiry,
    remainingDays: remainingDaysFrom(expiry),
    paymentSource: raw.paymentSource || null
  };
}

/**
 * Apply ACTIVE subscription fields on a user document (does not save).
 */
function applyActiveSubscriptionFields(user, {
  tier,
  provider,
  paymentSource,
  providerOrderId,
  providerCustomerId,
  billingCycle = 'monthly',
  startDate,
  expiryDate,
  periodDays,
  activatedBy
}) {
  const cycle = normalizeBillingCycle(billingCycle);
  const start = startDate ? new Date(startDate) : new Date();
  const days = resolvePeriodDays(cycle, periodDays);
  const end = expiryDate
    ? new Date(expiryDate)
    : new Date(start.getTime() + days * 24 * 60 * 60 * 1000);

  const prev = user.subscription?.toObject?.() || user.subscription || {};
  user.subscription = {
    ...prev,
    tier: tier || prev.tier || 'basic',
    status: 'active',
    provider: provider || prev.provider,
    paymentSource: paymentSource || prev.paymentSource,
    providerOrderId: providerOrderId || prev.providerOrderId,
    providerCustomerId: providerCustomerId || prev.providerCustomerId || undefined,
    billingCycle: cycle,
    startDate: start,
    current_period_end: end,
    activatedBy: activatedBy || prev.activatedBy || null,
    createdAt: prev.createdAt || start,
    updatedAt: new Date()
  };
  user.updatedAt = new Date();
  return user;
}

async function emitSubscriptionUpdated(io, user) {
  if (!io || !user) return;
  const userId = user._id?.toString() || user.id;
  io.emit('subscription:updated', {
    userId,
    subscription: sanitizeUser(user).subscription
  });
  // In-app style notice for connected clients of this user.
  io.to(`user:${userId}`).emit('notification', {
    type: 'subscription_activated',
    title: 'Subscription Activated',
    message: `Your ${TIER_DISPLAY_NAMES[user.subscription?.tier] || user.subscription?.tier || 'plan'} subscription is now active.`,
    subscription: serializeSubscription(user.subscription)
  });
}

async function ensureReferralCode(userId) {
  try {
    const ReferralService = require('./ReferralService');
    await ReferralService.ensureReferralCodeForUser(userId);
  } catch (error) {
    console.warn('[Referral] Referral code provisioning failed:', error.message);
  }
}

async function recordCommission(payment) {
  try {
    const ReferralService = require('./ReferralService');
    await ReferralService.recordCommissionFromPayment(payment);
  } catch (error) {
    console.warn('[Referral] Commission recording failed:', error.message);
  }
}

/**
 * Central activation: completed Payment → ACTIVE subscription.
 * Idempotent when the same payment is already linked as providerOrderId and status is active.
 */
async function activateFromCompletedPayment(payment, options = {}) {
  if (!payment) {
    throw Object.assign(new Error('Payment required.'), { status: 400 });
  }
  if (payment.status !== 'completed') {
    throw Object.assign(new Error('Payment must be completed before activation.'), { status: 400 });
  }

  const {
    io = null,
    activatedBy = null,
    startDate = null,
    expiryDate = null,
    periodDays = null,
    notes = null,
    sendEmail = true,
    skipCommission = false
  } = options;

  const paymentMethod = payment.paymentMethod || payment.provider;
  const paymentSource = options.paymentSource || mapPaymentSource(paymentMethod);
  const userId = payment.userId;

  if (!isDbReady()) {
    throw Object.assign(new Error('Database unavailable.'), { status: 503 });
  }

  let user;

  async function applyActivation(session = null) {
    const paymentQuery = PaymentTransaction.findById(payment._id);
    const lockedPayment = session ? await paymentQuery.session(session) : await paymentQuery;
    if (!lockedPayment) {
      throw Object.assign(new Error('Payment not found.'), { status: 404 });
    }
    if (lockedPayment.status !== 'completed') {
      throw Object.assign(new Error('Payment must be completed before activation.'), { status: 400 });
    }

    const userQuery = UserConfig.findById(userId);
    user = session ? await userQuery.session(session) : await userQuery;
    if (!user) {
      throw Object.assign(new Error('User not found.'), { status: 404 });
    }

    // Prevent duplicate activation of the same payment reference.
    const alreadyActiveSamePayment =
      user.subscription?.status === 'active' &&
      String(user.subscription?.providerOrderId || '') === String(lockedPayment.providerReference || '') &&
      lockedPayment.activationDate;

    if (!alreadyActiveSamePayment) {
      applyActiveSubscriptionFields(user, {
        tier: lockedPayment.tier,
        provider: lockedPayment.provider,
        paymentSource,
        providerOrderId: lockedPayment.providerReference,
        billingCycle: lockedPayment.billingCycle,
        startDate,
        expiryDate,
        periodDays:
          periodDays ??
          (lockedPayment.billingCycle === 'yearly' ? 365 : SUBSCRIPTION_PERIOD_DAYS),
        activatedBy
      });
      if (session) await user.save({ session });
      else await user.save();
    }

    lockedPayment.activatedBy = activatedBy || lockedPayment.activatedBy;
    lockedPayment.activationDate = lockedPayment.activationDate || new Date();
    lockedPayment.completedAt = lockedPayment.completedAt || new Date();
    lockedPayment.updatedAt = new Date();
    if (notes != null && String(notes).trim()) {
      lockedPayment.notes = [lockedPayment.notes, String(notes).trim()].filter(Boolean).join('\n');
    }
    if (session) await lockedPayment.save({ session });
    else await lockedPayment.save();
    payment = lockedPayment;
  }

  // Prefer a Mongo transaction when available (replica set); fall back for standalone.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await applyActivation(session);
    });
  } catch (error) {
    const msg = String(error?.message || '');
    const txnUnsupported =
      /transaction|replica set|mongos|not supported/i.test(msg) || error?.code === 20;
    if (!txnUnsupported) {
      session.endSession();
      throw error;
    }
    session.endSession();
    await applyActivation(null);
  } finally {
    try {
      session.endSession();
    } catch {
      /* already ended */
    }
  }

  await ensureReferralCode(userId);
  if (!skipCommission) {
    await recordCommission(payment);
  }
  await emitSubscriptionUpdated(io, user);

  if (sendEmail && user?.email) {
    try {
      await sendSubscriptionActivatedEmail({
        to: user.email,
        displayName: user.displayName,
        planName: TIER_DISPLAY_NAMES[user.subscription.tier] || user.subscription.tier,
        activationDate: user.subscription.startDate,
        expiryDate: user.subscription.current_period_end
      });
    } catch (error) {
      console.warn('[Activation] Activation email failed:', error.message);
    }
  }

  return { user, payment, subscription: serializeSubscription(user.subscription) };
}

/**
 * User submits "I Have Paid" — creates pending Payment only (no access yet).
 * Supports manual_mpesa (Till) and manual_binance (pay to Binance ID).
 */
async function submitManualPaymentRequest({
  userId,
  tier,
  billingCycle = 'monthly',
  method,
  provider,
  mpesaCode,
  binanceTxId,
  paymentReference,
  phoneNumber,
  amount,
  notes = '',
  screenshotUrl = ''
}) {
  const manualMethod = normalizeManualMethod(method || provider || 'manual_mpesa');
  if (!manualMethod) {
    throw Object.assign(new Error('Unsupported manual payment method.'), { status: 400 });
  }

  const rawReference = paymentReference || (manualMethod === 'manual_binance' ? binanceTxId : mpesaCode);
  const code =
    manualMethod === 'manual_binance' ? normalizeBinanceTxId(rawReference) : normalizeMpesaCode(rawReference);

  if (manualMethod === 'manual_mpesa') {
    if (!/^[A-Z0-9]{8,15}$/.test(code)) {
      throw Object.assign(new Error('Enter a valid M-Pesa transaction code (8–15 characters).'), {
        status: 400
      });
    }
  } else if (!/^[A-Z0-9_-]{6,64}$/.test(code)) {
    throw Object.assign(
      new Error('Enter a valid Binance transaction / order ID (6–64 characters).'),
      { status: 400 }
    );
  }

  const allowedTiers = new Set(['basic', 'professional', 'premium']);
  if (!allowedTiers.has(tier)) {
    throw Object.assign(new Error('Invalid plan.'), { status: 400 });
  }

  const cycle = normalizeBillingCycle(billingCycle);
  const pricing = getTierPricing(tier, cycle);
  const isBinance = manualMethod === 'manual_binance';
  const defaultAmount = isBinance
    ? Number((pricing.priceCents / 100).toFixed(2))
    : pricing.price;
  const paidAmount = amount != null && amount !== '' ? Number(amount) : defaultAmount;
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
    throw Object.assign(new Error('Amount must be a positive number.'), { status: 400 });
  }

  const phone = String(phoneNumber || '').trim();
  if (manualMethod === 'manual_mpesa') {
    if (!/^\+?[0-9]{9,15}$/.test(phone)) {
      throw Object.assign(new Error('Enter a valid phone number (9–15 digits).'), { status: 400 });
    }
  } else if (phone && !/^\+?[0-9]{9,15}$/.test(phone)) {
    throw Object.assign(new Error('Enter a valid phone number (9–15 digits), or leave it blank.'), {
      status: 400
    });
  }

  if (screenshotUrl && String(screenshotUrl).length > 400_000) {
    throw Object.assign(new Error('Screenshot is too large. Please upload a smaller image.'), {
      status: 400
    });
  }

  if (!isDbReady()) {
    throw Object.assign(new Error('Database unavailable.'), { status: 503 });
  }

  const existing = await PaymentTransaction.findOne({
    providerReference: code,
    provider: manualMethod
  }).lean();
  if (existing) {
    throw Object.assign(
      new Error(
        isBinance
          ? 'This Binance transaction ID has already been submitted.'
          : 'This M-Pesa code has already been submitted.'
      ),
      { status: 409 }
    );
  }

  const user = await UserConfig.findById(userId);
  if (!user) {
    throw Object.assign(new Error('User not found.'), { status: 404 });
  }

  // Mark subscription pending while awaiting verification (do not grant access).
  const prev = user.subscription?.toObject?.() || user.subscription || {};
  if (prev.status !== 'active') {
    user.subscription = {
      ...prev,
      tier,
      status: 'pending',
      billingCycle: cycle,
      updatedAt: new Date()
    };
    user.updatedAt = new Date();
    if (phone && !user.phone) {
      user.phone = phone;
    }
    await user.save();
  }

  try {
    const payment = await PaymentTransaction.create({
      userId,
      tier,
      provider: manualMethod,
      paymentMethod: manualMethod,
      amount: paidAmount,
      currency: isBinance ? pricing.currencyBinance || 'USDT' : pricing.currency || 'KES',
      billingCycle: cycle,
      providerReference: code,
      phoneNumber: phone || null,
      status: 'pending',
      notes: String(notes || '').trim().slice(0, 2000),
      screenshotUrl: String(screenshotUrl || '').slice(0, 400_000),
      rawPayload: isBinance
        ? {
            source: 'manual_binance_id',
            binanceId: BINANCE_ID_DEFAULT,
            businessName: BUSINESS_NAME_DEFAULT
          }
        : {
            source: 'manual_till',
            tillNumber: MPESA_TILL_DEFAULT,
            businessName: BUSINESS_NAME_DEFAULT
          },
      createdAt: new Date(),
      updatedAt: new Date()
    });
    return { payment, user, subscription: serializeSubscription(user.subscription) };
  } catch (error) {
    if (error?.code === 11000) {
      throw Object.assign(
        new Error(
          isBinance
            ? 'This Binance transaction ID has already been submitted.'
            : 'This M-Pesa code has already been submitted.'
        ),
        { status: 409 }
      );
    }
    throw error;
  }
}

/**
 * Super Admin approves a pending manual payment → completed payment + ACTIVE subscription.
 */
async function approveManualPayment(paymentId, adminUser, options = {}, req = null) {
  if (!isDbReady()) {
    throw Object.assign(new Error('Database unavailable.'), { status: 503 });
  }

  const payment = await PaymentTransaction.findById(paymentId);
  if (!payment) {
    throw Object.assign(new Error('Payment not found.'), { status: 404 });
  }
  if (!isManualPayment(payment)) {
    throw Object.assign(new Error('Only manual M-Pesa or Binance payments can be approved here.'), {
      status: 400
    });
  }
  if (payment.status === 'completed' && payment.activationDate) {
    throw Object.assign(new Error('This payment was already activated.'), { status: 409 });
  }
  if (payment.status === 'rejected' || payment.status === 'cancelled') {
    throw Object.assign(new Error(`Cannot approve a ${payment.status} payment.`), { status: 400 });
  }

  const adminId = adminUser._id || adminUser.id;
  const {
    tier,
    amount,
    phoneNumber,
    mpesaCode,
    binanceTxId,
    paymentReference,
    startDate,
    expiryDate,
    notes,
    billingCycle,
    io
  } = options;

  const method = normalizeManualMethod(payment.paymentMethod || payment.provider) || 'manual_mpesa';
  const isBinance = method === 'manual_binance';

  if (tier && ['basic', 'professional', 'premium'].includes(tier)) {
    payment.tier = tier;
  }
  if (amount != null && Number.isFinite(Number(amount)) && Number(amount) > 0) {
    payment.amount = Number(amount);
  }
  if (phoneNumber) {
    payment.phoneNumber = String(phoneNumber).trim();
  }

  const nextReferenceRaw = paymentReference || binanceTxId || mpesaCode;
  if (nextReferenceRaw) {
    const code = isBinance
      ? normalizeBinanceTxId(nextReferenceRaw)
      : normalizeMpesaCode(nextReferenceRaw);
    if (isBinance) {
      if (!/^[A-Z0-9_-]{6,64}$/.test(code)) {
        throw Object.assign(new Error('Invalid Binance transaction / order ID.'), { status: 400 });
      }
    } else if (!/^[A-Z0-9]{8,15}$/.test(code)) {
      throw Object.assign(new Error('Invalid M-Pesa code.'), { status: 400 });
    }
    if (code !== payment.providerReference) {
      const clash = await PaymentTransaction.findOne({
        providerReference: code,
        provider: method,
        _id: { $ne: payment._id }
      }).lean();
      if (clash) {
        throw Object.assign(
          new Error(
            isBinance
              ? 'Another payment already uses this Binance transaction ID.'
              : 'Another payment already uses this M-Pesa code.'
          ),
          { status: 409 }
        );
      }
      payment.providerReference = code;
    }
  }
  if (billingCycle) {
    payment.billingCycle = normalizeBillingCycle(billingCycle);
  }
  if (notes != null) {
    payment.notes = String(notes).trim().slice(0, 2000);
  }

  payment.status = 'completed';
  payment.completedAt = new Date();
  payment.updatedAt = new Date();
  await payment.save();

  const result = await activateFromCompletedPayment(payment, {
    io,
    activatedBy: adminId,
    startDate: startDate || new Date(),
    expiryDate: expiryDate || null,
    periodDays: expiryDate
      ? null
      : payment.billingCycle === 'yearly'
        ? 365
        : SUBSCRIPTION_PERIOD_DAYS,
    paymentSource: mapPaymentSource(method),
    notes: null,
    sendEmail: true,
    skipCommission: false
  });

  if (req) {
    await logAdminAction(req, {
      action: 'manual_payment.approve',
      targetType: 'payment',
      targetId: String(payment._id),
      summary: `Approved ${method} payment for ${result.user.email} (${result.user.subscription.tier})`,
      metadata: {
        paymentId: String(payment._id),
        userId: String(result.user._id),
        plan: result.user.subscription.tier,
        paymentMethod: method,
        paymentReference: payment.providerReference,
        mpesaCode: isBinance ? null : payment.providerReference,
        binanceTxId: isBinance ? payment.providerReference : null,
        amount: payment.amount,
        currency: payment.currency,
        startDate: result.user.subscription.startDate,
        expiryDate: result.user.subscription.current_period_end,
        notes: payment.notes || ''
      }
    });
  }

  return result;
}

async function rejectManualPayment(paymentId, adminUser, { notes = '', io = null } = {}, req = null) {
  if (!isDbReady()) {
    throw Object.assign(new Error('Database unavailable.'), { status: 503 });
  }

  const payment = await PaymentTransaction.findById(paymentId);
  if (!payment) {
    throw Object.assign(new Error('Payment not found.'), { status: 404 });
  }
  if (payment.status === 'completed' && payment.activationDate) {
    throw Object.assign(new Error('Cannot reject an already activated payment.'), { status: 409 });
  }
  if (payment.status === 'rejected') {
    throw Object.assign(new Error('Payment already rejected.'), { status: 409 });
  }

  payment.status = 'rejected';
  payment.failureReason = String(notes || 'Rejected by admin').slice(0, 500);
  if (notes) {
    payment.notes = [payment.notes, `Rejected: ${String(notes).trim()}`].filter(Boolean).join('\n').slice(0, 2000);
  }
  payment.updatedAt = new Date();
  await payment.save();

  const user = await UserConfig.findById(payment.userId);
  if (user && user.subscription?.status === 'pending') {
    // Keep pending so user can resubmit; do not grant access.
    user.subscription.updatedAt = new Date();
    await user.save();
  }

  if (req) {
    await logAdminAction(req, {
      action: 'manual_payment.reject',
      targetType: 'payment',
      targetId: String(payment._id),
      summary: `Rejected manual payment ${payment.providerReference} for user ${payment.userId}`,
      metadata: {
        paymentId: String(payment._id),
        userId: String(payment.userId),
        mpesaCode: payment.providerReference,
        notes: notes || ''
      }
    });
  }

  if (io && user) {
    const userId = user._id.toString();
    io.to(`user:${userId}`).emit('notification', {
      type: 'payment_rejected',
      title: 'Payment Rejected',
      message: notes || 'Your payment could not be verified. Please contact support or resubmit.'
    });
  }

  return { payment, user };
}

async function updateManualPaymentNotes(paymentId, notes, req = null) {
  const payment = await PaymentTransaction.findById(paymentId);
  if (!payment) {
    throw Object.assign(new Error('Payment not found.'), { status: 404 });
  }
  payment.notes = String(notes || '').trim().slice(0, 2000);
  payment.updatedAt = new Date();
  await payment.save();

  if (req) {
    await logAdminAction(req, {
      action: 'manual_payment.notes',
      targetType: 'payment',
      targetId: String(payment._id),
      summary: `Updated notes on payment ${payment.providerReference}`,
      metadata: { notes: payment.notes }
    });
  }
  return payment;
}

async function extendUserSubscription(userId, adminUser, { days, notes = '', io = null } = {}, req = null) {
  const extendDays = Math.max(1, parseInt(days, 10) || 0);
  if (!extendDays) {
    throw Object.assign(new Error('days is required.'), { status: 400 });
  }

  const user = await UserConfig.findById(userId);
  if (!user) {
    throw Object.assign(new Error('User not found.'), { status: 404 });
  }

  const sub = user.subscription?.toObject?.() || user.subscription || {};
  const base =
    sub.current_period_end && new Date(sub.current_period_end) > new Date()
      ? new Date(sub.current_period_end)
      : new Date();
  const nextEnd = new Date(base.getTime() + extendDays * 24 * 60 * 60 * 1000);

  user.subscription = {
    ...sub,
    status: 'active',
    current_period_end: nextEnd,
    paymentSource: sub.paymentSource || 'ADMIN',
    provider: sub.provider || 'admin',
    activatedBy: adminUser._id || adminUser.id || sub.activatedBy,
    startDate: sub.startDate || new Date(),
    updatedAt: new Date()
  };
  user.updatedAt = new Date();
  await user.save();

  if (req) {
    await logAdminAction(req, {
      action: 'subscription.extend',
      targetType: 'user',
      targetId: String(user._id),
      summary: `Extended subscription for ${user.email} by ${extendDays} days`,
      metadata: { days: extendDays, expiryDate: nextEnd, notes }
    });
  }

  await emitSubscriptionUpdated(io, user);
  return { user, subscription: serializeSubscription(user.subscription) };
}

async function cancelUserSubscription(userId, adminUser, { notes = '', io = null } = {}, req = null) {
  const user = await UserConfig.findById(userId);
  if (!user) {
    throw Object.assign(new Error('User not found.'), { status: 404 });
  }

  const sub = user.subscription?.toObject?.() || user.subscription || {};
  user.subscription = {
    ...sub,
    status: 'cancelled',
    updatedAt: new Date()
  };
  user.updatedAt = new Date();
  await user.save();

  if (req) {
    await logAdminAction(req, {
      action: 'subscription.cancel',
      targetType: 'user',
      targetId: String(user._id),
      summary: `Cancelled subscription for ${user.email}`,
      metadata: { notes, cancelledBy: adminUser?.email }
    });
  }

  if (io) {
    const uid = user._id.toString();
    io.emit('subscription:updated', {
      userId: uid,
      subscription: sanitizeUser(user).subscription
    });
  }

  return { user, subscription: serializeSubscription(user.subscription) };
}

/**
 * Hourly job: ACTIVE subscriptions past expiryDate → EXPIRED (access revoked immediately).
 */
async function expireDueSubscriptions({ io = null } = {}) {
  if (!isDbReady()) {
    return { expired: 0 };
  }

  const now = new Date();
  const due = await UserConfig.find({
    'subscription.status': 'active',
    'subscription.current_period_end': { $lt: now },
    role: { $nin: ['admin', 'super_admin'] }
  }).select('_id email subscription');

  let expired = 0;
  for (const user of due) {
    const sub = user.subscription?.toObject?.() || user.subscription || {};
    user.subscription = {
      ...sub,
      status: 'expired',
      updatedAt: now
    };
    user.updatedAt = now;
    await user.save();
    expired += 1;

    if (io) {
      const uid = user._id.toString();
      io.emit('subscription:updated', {
        userId: uid,
        subscription: sanitizeUser(user).subscription
      });
      io.to(`user:${uid}`).emit('notification', {
        type: 'subscription_expired',
        title: 'Subscription Expired',
        message: 'Your subscription has expired. Renew on Pricing to restore access.'
      });
    }
  }

  if (expired > 0) {
    console.log(`[Activation] Expired ${expired} subscription(s)`);
  }
  return { expired };
}

let expiryTimer = null;

function startExpiryJob(io, { intervalMs = 60 * 60 * 1000 } = {}) {
  if (expiryTimer) {
    clearInterval(expiryTimer);
  }
  // Run once shortly after boot, then hourly.
  setTimeout(() => {
    expireDueSubscriptions({ io }).catch(err => {
      console.error('[Activation] Expiry job error:', err.message);
    });
  }, 15_000);

  expiryTimer = setInterval(() => {
    expireDueSubscriptions({ io }).catch(err => {
      console.error('[Activation] Expiry job error:', err.message);
    });
  }, intervalMs);

  if (typeof expiryTimer.unref === 'function') {
    expiryTimer.unref();
  }
  return expiryTimer;
}

function stopExpiryJob() {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
}

async function listManualPayments({
  status,
  search,
  page = 1,
  limit = 25
} = {}) {
  const filter = {
    $or: [
      { provider: 'manual_mpesa' },
      { paymentMethod: 'manual_mpesa' },
      { provider: 'manual_binance' },
      { paymentMethod: 'manual_binance' }
    ]
  };

  if (status === 'pending' || status === 'completed' || status === 'rejected' || status === 'cancelled') {
    filter.status = status;
  } else if (status === 'active') {
    filter.status = 'completed';
  } else if (status === 'expired') {
    // Payments themselves don't expire — filter users via join below conceptually;
    // for list we treat completed + user expired separately in UI. Keep completed.
    filter.status = 'completed';
  }

  if (search && String(search).trim()) {
    const q = String(search).trim();
    const users = await UserConfig.find({
      $or: [
        { email: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { displayName: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { phone: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
      ]
    })
      .select('_id')
      .lean();
    const userIds = users.map(u => u._id);
    filter.$and = [
      {
        $or: [
          { providerReference: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
          { phoneNumber: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
          ...(userIds.length ? [{ userId: { $in: userIds } }] : [])
        ]
      }
    ];
  }

  const skip = (Math.max(1, page) - 1) * Math.min(100, Math.max(1, limit));
  const lim = Math.min(100, Math.max(1, limit));

  const [rows, total] = await Promise.all([
    PaymentTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .populate('userId', 'email displayName phone subscription')
      .populate('activatedBy', 'email displayName')
      .lean(),
    PaymentTransaction.countDocuments(filter)
  ]);

  const payments = rows.map(row => {
    const user = row.userId && typeof row.userId === 'object' ? row.userId : null;
    const sub = user?.subscription || {};
    const method = row.paymentMethod || row.provider;
    const isBinance = method === 'manual_binance';
    return {
      id: String(row._id),
      userId: user?._id ? String(user._id) : String(row.userId),
      userEmail: user?.email || null,
      userName: user?.displayName || null,
      userPhone: user?.phone || null,
      plan: row.tier,
      tier: row.tier,
      phone: row.phoneNumber || user?.phone || null,
      mpesaCode: isBinance ? null : row.providerReference,
      binanceTxId: isBinance ? row.providerReference : null,
      paymentReference: row.providerReference,
      amount: row.amount,
      currency: row.currency,
      billingCycle: row.billingCycle,
      status: row.status,
      subscriptionStatus: sub.status || null,
      notes: row.notes || '',
      screenshotUrl: row.screenshotUrl || '',
      paymentMethod: method,
      activatedBy: row.activatedBy?.email || null,
      activationDate: row.activationDate || null,
      createdAt: row.createdAt,
      completedAt: row.completedAt || null,
      subscription: serializeSubscription(sub)
    };
  });

  return {
    payments,
    page: Math.max(1, page),
    limit: lim,
    total,
    pages: Math.ceil(total / lim) || 0
  };
}

module.exports = {
  SUBSCRIPTION_PERIOD_DAYS,
  remainingDaysFrom,
  normalizeMpesaCode,
  normalizeBinanceTxId,
  normalizeManualMethod,
  isManualPayment,
  mapPaymentSource,
  serializeSubscription,
  activateFromCompletedPayment,
  submitManualPaymentRequest,
  approveManualPayment,
  rejectManualPayment,
  updateManualPaymentNotes,
  extendUserSubscription,
  cancelUserSubscription,
  expireDueSubscriptions,
  startExpiryJob,
  stopExpiryJob,
  listManualPayments,
  applyActiveSubscriptionFields
};
