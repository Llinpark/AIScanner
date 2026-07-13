const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const dotenv = require('dotenv');

dotenv.config();

const Signal = require('./models/Signal');
const UserConfig = require('./models/User');

const { TIERS, PAYMENT_CONFIG, getPublicTiers, FEATURE_MATRIX } = require('./config/subscriptions');
const MpesaService = require('./services/MpesaService');
const PayPalService = require('./services/PayPalService');
const {
  activateSubscription,
  createPaymentTransaction,
  completePaymentTransaction,
  getPaymentStatus,
  findPaymentByReference
} = require('./services/SubscriptionService');
const TradingViewService = require('./services/TradingViewService');
const TradingViewAlertService = require('./services/TradingViewAlertService');
const {
  normalizeSignalLevels,
  validateKachingEntrySignal
} = require('./utils/kachingSignalLevels');
const MarketScannerService = require('./services/MarketScannerService');
const SignalEnrichmentService = require('./services/SignalEnrichmentService');
const SignalOutcomeService = require('./services/SignalOutcomeService');
const createAnalyticsRouter = require('./routes/analytics');
const createJournalRouter = require('./routes/journal');
const createTelegramRouter = require('./routes/telegram');
const PineScriptGeneratorService = require('./services/PineScriptGeneratorService');
const TelegramService = require('./services/TelegramService');
const { buildAnalytics } = require('./utils/signalOutcome');
const { verifyTradingViewWebhook } = require('./utils/webhookSecurity');
const authRoutes = require('./routes/auth');
const requireAuth = require('./middleware/requireAuth');
const { resolveUserById } = require('./middleware/requireAuth');
const requireSubscription = require('./middleware/requireSubscription');
const requireTierFeature = require('./middleware/requireTierFeature');
const requireTradingViewAccess = require('./middleware/requireTradingViewAccess');
const validateRequest = require('./middleware/validate');
const { subscribeValidators } = require('./validators/authValidators');
const {
  canAccessLiveAlerts,
  canAccessTradingViewAlerts,
  getTierFeatures,
  getTierDisplayName,
  historyCutoffDate,
  sanitizeSignalForTier,
  filterSignalsForTier,
  isCurrencyPairAllowed,
  isTimeframeAllowed,
  getAllowedCurrencyPairs
} = require('./utils/subscriptionAccess');
const { verifyToken, sanitizeUser } = require('./utils/auth');

const TRADINGVIEW_WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || '';
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;

const devUserStore = require('./utils/devUserStore');


function isDbReady() {
  return mongoose.connection.readyState === 1;
}

async function resolveUser(username) {
  if (!isDbReady()) {
    return devUserStore.findByUsername(username);
  }
  try {
    return await UserConfig.findOne({ username });
  } catch {
    return devUserStore.findByUsername(username);
  }
}

async function assertTradingViewWebhook(req, res) {
  const auth = await verifyTradingViewWebhook(req, resolveUserById);
  if (!auth.ok) {
    res.status(401).json({
      message: 'Invalid webhook authentication',
      reason: auth.reason || 'unauthorized'
    });
    return null;
  }
  req.webhookAuth = auth;
  return auth;
}

function parseTradingViewPayload(body) {
  const parsed = TradingViewAlertService.parseWebhookBody(body);
  const symbol = parsed.symbol || parsed.ticker || parsed.instrument || parsed.market || parsed.data?.symbol || 'UNKNOWN';
  const direction = (parsed.direction || parsed.action || parsed.signal || parsed.trade || 'neutral').toString().toLowerCase();
  const levels = normalizeSignalLevels(parsed, direction);
  const confidence = parseFloat(parsed.confidence || parsed.confidence_score || parsed.data?.confidence || 0) || 0;
  const notes = parsed.message || parsed.note || parsed.notes || JSON.stringify(parsed);
  const tradingviewUsername = TradingViewAlertService.normalizeTradingViewUsername(
    parsed.tradingviewUsername || parsed.username || parsed.user || parsed.trader || ''
  );

  const payload = {
    symbol,
    direction,
    ...levels,
    confidence: Math.min(Math.max(confidence, 0), 1),
    notes,
    tradingviewUsername,
    alertType: TradingViewAlertService.normalizeAlertType(parsed.alertType || parsed.alert_type || parsed.type)
  };

  validateKachingEntrySignal(payload);
  return payload;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST']
  }
});

function captureRawBody(req, res, buf) {
  if (buf?.length) {
    req.rawBody = buf;
  }
}

app.use(cors());
app.use(express.json({ limit: '1mb', verify: captureRawBody }));
app.use(express.text({ type: ['text/*', 'application/x-www-form-urlencoded'], verify: captureRawBody }));

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/kachingscanner';
mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'backend', dbState: mongoose.connection.readyState });
});

app.use('/api/auth', authRoutes);

const inMemorySignals = [];

app.use('/api/analytics', createAnalyticsRouter({ inMemorySignals, isDbReady }));
app.use('/api/journal', createJournalRouter());
app.use('/api/telegram', createTelegramRouter());

app.post('/api/signals', async (req, res) => {
  try {
    const payload = req.body;
    validateKachingEntrySignal(payload);

    if (!isDbReady()) {
      const enriched = SignalEnrichmentService.enrichSignal(payload);
      const fallback = Object.assign({}, enriched, { createdAt: new Date(), _id: `mem_${Date.now()}` });
      inMemorySignals.unshift(fallback);
      io.emit('signal:update', fallback);
      return res.status(201).json({ fallback: true, signal: fallback });
    }

    const enriched = SignalEnrichmentService.enrichSignal(payload);
    const signal = new Signal(enriched);
    const saved = await signal.save();
    io.emit('signal:update', saved);

    await TradingViewAlertService.broadcastToSubscribers(io, {
      ...payload,
      source: payload.source || 'scanner',
      alertType: TradingViewAlertService.normalizeAlertType(payload.alertType || 'signal')
    });

    return res.status(201).json(saved);
  } catch (error) {
    console.error('Error saving signal:', error);
    const fallback = Object.assign({}, req.body, { createdAt: new Date(), _id: null });
    inMemorySignals.unshift(fallback);
    io.emit('signal:update', fallback);
    return res.status(201).json({ fallback: true, signal: fallback, error: String(error) });
  }
});

app.post('/api/webhook/telegram', async (req, res) => {
  try {
    const result = await TelegramService.handleWebhook(req);
    if (!result.ok) {
      return res.status(result.status || 401).json({ message: result.message || 'Unauthorized' });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    res.status(500).json({ message: 'Telegram webhook processing failed', error: error.message });
  }
});

app.post('/api/webhook/tradingview', async (req, res) => {
  try {
    const auth = await assertTradingViewWebhook(req, res);
    if (!auth) return;

    const parsed = TradingViewAlertService.parseWebhookBody(req.body);
    const isStructuredEntry =
      parsed.alertType === 'entry' || parsed.pattern === 'perfect_fvg' || parsed.pattern === 'breakaway_gap';
    const isCandleFeed = parsed.alertType === 'candle' || parsed.pattern === 'feed';
    const isCandlePayload =
      !isStructuredEntry &&
      parsed.open != null &&
      parsed.high != null &&
      parsed.low != null &&
      parsed.close != null;

    if ((isCandlePayload || isCandleFeed) && parsed.symbol && !isStructuredEntry) {
      const scanResult = await MarketScannerService.ingestCandle(io, {
        symbol: parsed.symbol || parsed.ticker,
        open: parsed.open,
        high: parsed.high,
        low: parsed.low,
        close: parsed.close,
        volume: parsed.volume,
        time: parsed.time
      });
      return res.status(201).json({ success: true, mode: 'candle_scan', scanResult });
    }

    const result = await TradingViewAlertService.processIncomingWebhook(io, req.body, inMemorySignals);
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error('TradingView webhook error:', error);
    return res.status(500).json({ message: 'TradingView webhook processing failed', error: error.message });
  }
});

app.get('/api/signals', requireAuth, requireSubscription, async (req, res) => {
  try {
    const features = getTierFeatures(req.user.subscription);
    const cutoff = historyCutoffDate(req.user.subscription);

    if (!isDbReady()) {
      const filtered = filterSignalsForTier(
        inMemorySignals.filter(s => !s.createdAt || new Date(s.createdAt) >= cutoff),
        req.user.subscription
      )
        .slice(0, features.maxSignals)
        .map(s => sanitizeSignalForTier(s, req.user.subscription));
      return res.json(filtered);
    }

    const signals = await Signal.find({
      createdAt: { $gte: cutoff }
    })
      .sort({ createdAt: -1 })
      .limit(features.maxSignals * 2);

    const sanitized = filterSignalsForTier(signals, req.user.subscription)
      .slice(0, features.maxSignals)
      .map(s => sanitizeSignalForTier(s, req.user.subscription));

    if (inMemorySignals.length) {
      const memoryFiltered = filterSignalsForTier(
        inMemorySignals.filter(s => !s.createdAt || new Date(s.createdAt) >= cutoff),
        req.user.subscription
      )
        .slice(0, features.maxSignals)
        .map(s => sanitizeSignalForTier(s, req.user.subscription));
      return res.json(memoryFiltered.concat(sanitized).slice(0, features.maxSignals));
    }
    res.json(sanitized);
  } catch (error) {
    console.error('Error fetching signals:', error);
    return res.status(500).json({ message: 'Unable to fetch signals', error: String(error) });
  }
});

app.get('/api/v1/signals', requireAuth, requireSubscription, requireTierFeature('apiAccess'), async (req, res) => {
  try {
    const features = getTierFeatures(req.user.subscription);
    const cutoff = historyCutoffDate(req.user.subscription);
    const limit = Math.min(parseInt(req.query.limit, 10) || features.maxSignals, features.maxSignals);

    const rawSignals = isDbReady()
      ? await Signal.find({ createdAt: { $gte: cutoff } })
          .sort({ createdAt: -1 })
          .limit(limit * 2)
      : inMemorySignals.filter(s => !s.createdAt || new Date(s.createdAt) >= cutoff);

    const signals = filterSignalsForTier(rawSignals, req.user.subscription).slice(0, limit);

    res.json({
      tier: req.user.subscription?.tier || 'basic',
      count: signals.length,
      signals: signals.map(s => sanitizeSignalForTier(s, req.user.subscription))
    });
  } catch (error) {
    console.error('API v1 signals error:', error);
    return res.status(500).json({ message: 'Unable to fetch signals', error: String(error) });
  }
});

// ===== SUBSCRIPTION ENDPOINTS =====

app.get('/api/tiers', (req, res) => {
  res.json({ tiers: getPublicTiers(), featureMatrix: FEATURE_MATRIX });
});

app.post('/api/subscribe', requireAuth, subscribeValidators, validateRequest, async (req, res) => {
  try {
    const { tier, provider, phone } = req.body;
    const userId = req.userId;

    let user = await UserConfig.findByIdAndUpdate(
      userId,
      { phone: phone || req.user.phone, updatedAt: new Date() },
      { new: true }
    );

    if (!user && !isDbReady()) {
      user = devUserStore.upsertUser(userId, { phone: phone || req.user.phone });
    }

    if (!user) {
      return res.status(503).json({ message: 'Database unavailable. Try again shortly.' });
    }

    if (provider === 'mock') {
      const mockPaymentId = `mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      user = await UserConfig.findByIdAndUpdate(
        userId,
        {
          phone: phone || user.phone,
          subscription: {
            tier,
            status: 'pending',
            provider: 'mock',
            providerOrderId: mockPaymentId
          },
          updatedAt: new Date()
        },
        { new: true }
      );

      if (!user && !isDbReady()) {
        user = devUserStore.upsertUser(userId, {
          phone: phone || req.user.phone,
          subscription: {
            tier,
            status: 'pending',
            provider: 'mock',
            providerOrderId: mockPaymentId
          }
        });
      }

      return res.json({
        success: true,
        message: 'Mock payment initiated',
        user: sanitizeUser(user),
        mockPaymentId
      });
    }

    if (provider === 'mpesa') {
      if (!phone) {
        return res.status(400).json({ message: 'Phone number is required for M-Pesa payment' });
      }

      const tierConfig = TIERS[tier];
      let stkResult;

      if (PAYMENT_CONFIG.mode === 'mock' || !MpesaService.isConfigured()) {
        stkResult = {
          checkoutRequestId: `stk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          merchantRequestId: `mr_${Date.now()}`,
          customerMessage: 'Mock STK push — configure M-Pesa credentials for live payments'
        };
      } else {
        stkResult = await MpesaService.initiateStkPush({
          phone,
          amount: tierConfig.price,
          accountReference: userId,
          description: `KachingFx ${tierConfig.name}`
        });
      }

      await createPaymentTransaction({
        userId,
        tier,
        provider: 'mpesa',
        amount: tierConfig.price,
        currency: tierConfig.currency,
        providerReference: stkResult.checkoutRequestId,
        merchantRequestId: stkResult.merchantRequestId
      });

      user = await UserConfig.findByIdAndUpdate(
        userId,
        {
          phone,
          subscription: {
            tier,
            status: 'pending',
            provider: 'mpesa',
            providerOrderId: stkResult.checkoutRequestId
          },
          updatedAt: new Date()
        },
        { new: true }
      );

      if (!user && !isDbReady()) {
        user = devUserStore.upsertUser(userId, {
          phone,
          subscription: {
            tier,
            status: 'pending',
            provider: 'mpesa',
            providerOrderId: stkResult.checkoutRequestId
          }
        });
      }

      return res.json({
        success: true,
        message: stkResult.customerMessage || 'M-Pesa STK push initiated. Check your phone for the prompt.',
        user: sanitizeUser(user),
        stkRequestId: stkResult.checkoutRequestId,
        checkoutRequestId: stkResult.checkoutRequestId,
        amount: tierConfig.price,
        tillNumber: PAYMENT_CONFIG.mpesa.shortcode,
        mockMode: PAYMENT_CONFIG.mode === 'mock' || !MpesaService.isConfigured()
      });
    }

    if (provider === 'paypal') {
      const tierConfig = TIERS[tier];
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const returnUrl = `${PUBLIC_BACKEND_URL}/api/payments/paypal/return?tier=${tier}`;
      const cancelUrl = `${frontendUrl}?paypal=cancelled`;

      let orderResult;

      if (PAYMENT_CONFIG.mode === 'mock' || !PayPalService.isConfigured()) {
        const mockOrderId = `paypal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        orderResult = {
          orderId: mockOrderId,
          approveUrl: `${frontendUrl}?paypal=mock&orderId=${mockOrderId}&tier=${tier}`
        };
      } else {
        orderResult = await PayPalService.createOrder({
          tier,
          userId: userId.toString(),
          returnUrl,
          cancelUrl
        });
      }

      await createPaymentTransaction({
        userId,
        tier,
        provider: 'paypal',
        amount: tierConfig.priceCents / 100,
        currency: tierConfig.currencyPayPal,
        providerReference: orderResult.orderId
      });

      user = await UserConfig.findByIdAndUpdate(
        userId,
        {
          subscription: {
            tier,
            status: 'pending',
            provider: 'paypal',
            providerOrderId: orderResult.orderId
          },
          updatedAt: new Date()
        },
        { new: true }
      );

      if (!user && !isDbReady()) {
        user = devUserStore.upsertUser(userId, {
          subscription: {
            tier,
            status: 'pending',
            provider: 'paypal',
            providerOrderId: orderResult.orderId
          }
        });
      }

      return res.json({
        success: true,
        message: 'PayPal checkout session created',
        user: sanitizeUser(user),
        checkoutId: orderResult.orderId,
        checkoutUrl: orderResult.approveUrl,
        amount: tierConfig.priceCents / 100,
        currency: tierConfig.currencyPayPal,
        mockMode: PAYMENT_CONFIG.mode === 'mock' || !PayPalService.isConfigured()
      });
    }
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ message: 'Unable to initiate subscription', error: error.message });
  }
});


app.get('/api/subscription/me', requireAuth, (req, res) => {
  const tier = req.user.subscription?.tier || 'basic';
  res.json({
    user: sanitizeUser(req.user),
    tierFeatures: getTierFeatures(req.user.subscription),
    tierDisplayName: getTierDisplayName(tier),
    allowedCurrencyPairs: getAllowedCurrencyPairs(req.user.subscription)
  });
});

app.post('/api/payments/mock/confirm', requireAuth, async (req, res) => {
  try {
    const { paymentId, tier } = req.body;

    if (!paymentId || !tier) {
      return res.status(400).json({ message: 'paymentId and tier are required' });
    }

    await completePaymentTransaction(paymentId, 'mock', { rawPayload: { mock: true } });

    const user = await activateSubscription(
      req.userId,
      { tier, provider: 'mock', providerOrderId: paymentId },
      io
    );

    res.json({
      success: true,
      message: 'Subscription activated! Open TradingView for live Kaching Entry, Kaching SL, Kaching TP1, Kaching TP2, and Kaching TP3 alerts.',
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error('Mock payment confirm error:', error);
    res.status(500).json({ message: 'Unable to confirm mock payment', error: error.message });
  }
});

app.get('/api/payments/mpesa/status/:checkoutRequestId', requireAuth, async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;
    const transaction = await getPaymentStatus(checkoutRequestId, 'mpesa', req.userId);

    if (!transaction) {
      return res.status(404).json({ message: 'Payment not found' });
    }

    res.json({
      status: transaction.status,
      tier: transaction.tier,
      failureReason: transaction.failureReason,
      subscriptionActive: req.user.subscription?.status === 'active'
    });
  } catch (error) {
    console.error('M-Pesa status error:', error);
    res.status(500).json({ message: 'Unable to check payment status', error: error.message });
  }
});

app.post('/api/payments/mpesa/mock-complete', requireAuth, async (req, res) => {
  try {
    const { checkoutRequestId, tier } = req.body;

    if (!checkoutRequestId || !tier) {
      return res.status(400).json({ message: 'checkoutRequestId and tier are required' });
    }

    const transaction = await getPaymentStatus(checkoutRequestId, 'mpesa', req.userId);
    if (!transaction || transaction.status !== 'pending') {
      return res.status(400).json({ message: 'No pending M-Pesa payment found' });
    }

    await completePaymentTransaction(checkoutRequestId, 'mpesa', { rawPayload: { mock: true } });

    const user = await activateSubscription(
      req.userId,
      { tier, provider: 'mpesa', providerOrderId: checkoutRequestId },
      io
    );

    res.json({
      success: true,
      message: 'M-Pesa payment confirmed (mock mode)',
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error('M-Pesa mock complete error:', error);
    res.status(500).json({ message: 'Unable to confirm M-Pesa payment', error: error.message });
  }
});

app.get('/api/payments/paypal/return', async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  try {
    const { token: orderId, tier } = req.query;

    if (!orderId) {
      return res.redirect(`${frontendUrl}?paypal=error&message=missing_order`);
    }

    const captureResult = await PayPalService.captureOrder(orderId);
    const customId = captureResult.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id
      || captureResult.purchase_units?.[0]?.custom_id;
    const [userId, capturedTier] = (customId || '').split(':');
    const resolvedTier = tier || capturedTier || 'basic';

    await completePaymentTransaction(orderId, 'paypal', { rawPayload: captureResult });

    if (userId) {
      await activateSubscription(
        userId,
        { tier: resolvedTier, provider: 'paypal', providerOrderId: orderId },
        io
      );
    }

    return res.redirect(`${frontendUrl}?paypal=success&tier=${resolvedTier}`);
  } catch (error) {
    console.error('PayPal return error:', error);
    return res.redirect(`${frontendUrl}?paypal=error&message=${encodeURIComponent(error.message)}`);
  }
});

app.post('/api/payments/paypal/mock-complete', requireAuth, async (req, res) => {
  try {
    const { orderId, tier } = req.body;

    if (!orderId || !tier) {
      return res.status(400).json({ message: 'orderId and tier are required' });
    }

    const transaction = await getPaymentStatus(orderId, 'paypal', req.userId);
    if (!transaction || transaction.status !== 'pending') {
      return res.status(400).json({ message: 'No pending PayPal payment found' });
    }

    await completePaymentTransaction(orderId, 'paypal', { rawPayload: { mock: true } });

    const user = await activateSubscription(
      req.userId,
      { tier, provider: 'paypal', providerOrderId: orderId },
      io
    );

    res.json({
      success: true,
      message: 'PayPal payment confirmed (mock mode)',
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error('PayPal mock complete error:', error);
    res.status(500).json({ message: 'Unable to confirm PayPal payment', error: error.message });
  }
});

app.get('/api/subscription/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const user = await resolveUser(username);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      username,
      subscription: user.subscription || { status: 'inactive', tier: 'basic' },
      email: user.email,
      phone: user.phone
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ message: 'Unable to fetch subscription', error: error.message });
  }
});

app.post('/api/webhook/mpesa', async (req, res) => {
  try {
    console.log('M-Pesa webhook received:', JSON.stringify(req.body));
    const callback = MpesaService.parseStkCallback(req.body);

    if (!callback) {
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const PaymentTransaction = require('./models/PaymentTransaction');
    const transaction = await findPaymentByReference(callback.checkoutRequestId, 'mpesa');

    if (!transaction) {
      console.warn('M-Pesa callback for unknown transaction:', callback.checkoutRequestId);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    if (callback.resultCode === 0) {
      await completePaymentTransaction(callback.checkoutRequestId, 'mpesa', { rawPayload: callback });
      await activateSubscription(
        transaction.userId,
        {
          tier: transaction.tier,
          provider: 'mpesa',
          providerOrderId: callback.checkoutRequestId,
          providerCustomerId: callback.mpesaReceiptNumber
        },
        io
      );
    } else {
      await completePaymentTransaction(callback.checkoutRequestId, 'mpesa', {
        rawPayload: callback,
        failureReason: callback.resultDesc
      });
    }

    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (error) {
    console.error('M-Pesa webhook error:', error);
    res.status(200).json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

app.post('/api/webhook/paypal', async (req, res) => {
  try {
    console.log('PayPal webhook received:', req.body?.event_type);
    const { eventType, customId, orderId } = PayPalService.parseWebhookEvent(req.body);

    if (eventType === 'PAYMENT.CAPTURE.COMPLETED' || eventType === 'CHECKOUT.ORDER.APPROVED') {
      const [userId, tier] = (customId || '').split(':');

      if (userId && orderId) {
        const existing = await getPaymentStatus(orderId, 'paypal');
        if (existing && existing.status === 'pending') {
          if (eventType === 'CHECKOUT.ORDER.APPROVED') {
            try {
              await PayPalService.captureOrder(orderId);
            } catch (captureErr) {
              console.warn('PayPal auto-capture skipped:', captureErr.message);
            }
          }

          await completePaymentTransaction(orderId, 'paypal', { rawPayload: req.body });
          await activateSubscription(
            userId,
            { tier: tier || existing.tier, provider: 'paypal', providerOrderId: orderId },
            io
          );
        }
      }
    }

    res.status(200).json({ status: 'received' });
  } catch (error) {
    console.error('PayPal webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/webhook/payments', async (req, res) => {
  try {
    const { event, provider, userId, tier, status } = req.body;

    if (!userId || !provider) {
      return res.status(400).json({ message: 'userId and provider are required' });
    }

    if (status === 'success' || event === 'payment.completed') {
      const user = await UserConfig.findByIdAndUpdate(
        userId,
        {
          subscription: {
            tier: tier || 'basic',
            status: 'active',
            provider,
            current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            updatedAt: new Date()
          }
        },
        { new: true }
      );

      io.emit('subscription:updated', { userId, subscription: user.subscription });
      return res.json({ success: true, message: 'Subscription activated', user: sanitizeUser(user) });
    }

    if (status === 'cancelled' || event === 'payment.cancelled') {
      const user = await UserConfig.findByIdAndUpdate(
        userId,
        { 'subscription.status': 'cancelled' },
        { new: true }
      );

      io.emit('subscription:updated', { userId, subscription: user.subscription });
      return res.json({ success: true, message: 'Subscription cancelled', user: sanitizeUser(user) });
    }

    res.json({ message: 'Event processed' });
  } catch (error) {
    console.error('Payment webhook error:', error);
    res.status(500).json({ message: 'Webhook processing error', error: error.message });
  }
});


// ===== TRADINGVIEW SETUP (subscribers use TradingView as alert front-end) =====

app.get('/api/tradingview/setup', requireAuth, requireSubscription, (req, res) => {
  res.json({
    liveAlertsEnabled: true,
    subscription: req.user.subscription,
    instructions: [
      'Open TradingView and add the KachingFx Structural Scanner indicator to your chart.',
      'Create alerts for Kaching Entry, Kaching SL, Kaching TP1, Kaching TP2, and Kaching TP3.',
      'Enable TradingView push/email notifications so alerts reach you in real time.',
      'Live signals from KachingFx are also delivered to this dashboard while your subscription is active.'
    ]
  });
});

// ===== TRADINGVIEW INTEGRATION ENDPOINTS =====

// Get TradingView OAuth URL for frontend redirect
app.get('/api/tradingview/oauth-url', (req, res) => {
  const state = `state_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const url = TradingViewService.getOAuthUrl(state);
  res.json({ oauthUrl: url, state });
});

// OAuth callback endpoint (TradingView redirects here after user authorizes)
app.get('/api/tradingview/oauth-callback', async (req, res) => {
  try {
    const { code, state, username } = req.query;

    if (!code) {
      return res.status(400).json({ message: 'Authorization code missing' });
    }

    // Exchange code for access token
    const tokenResponse = await TradingViewService.exchangeCodeForToken(code);

    // Store OAuth credentials in user profile
    const user = await UserConfig.findOneAndUpdate(
      { username },
      {
        tradingview: {
          userId: tokenResponse.user_id,
          oauthToken: tokenResponse.access_token,
          linkedAt: new Date(),
          isOAuthLinked: true,
          apiAccessLevel: 'premium'
        }
      },
      { new: true }
    );

    io.emit('tradingview:linked', { username, userId: tokenResponse.user_id });

    // Redirect to frontend with success message
    res.redirect(`http://localhost:5173?tradingview_linked=true&username=${username}`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ message: 'OAuth callback failed', error: error.message });
  }
});

// Link TradingView account by username (username-based, no OAuth)
app.post('/api/tradingview/link', requireTradingViewAccess, async (req, res) => {
  try {
    const { username, tradingviewUsername } = req.body;

    if (!username || !tradingviewUsername) {
      return res.status(400).json({ message: 'Both username and tradingviewUsername are required' });
    }

    const normalizedTv = TradingViewAlertService.normalizeTradingViewUsername(tradingviewUsername);
    const existing = await UserConfig.findOne({
      tradingviewUsername: { $regex: new RegExp(`^${normalizedTv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      username: { $ne: username }
    });

    if (existing) {
      return res.status(409).json({ message: 'This TradingView username is already linked to another account.' });
    }

    const user = await UserConfig.findOneAndUpdate(
      { username },
      {
        tradingviewUsername: normalizedTv,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );

    res.json({
      success: true,
      message: 'TradingView account linked. Live entry, stop loss, and take profit alerts are enabled.',
      user,
      tradingviewUsername: user.tradingviewUsername
    });
  } catch (error) {
    console.error('TradingView link error:', error);
    res.status(500).json({ message: 'Unable to link TradingView account', error: error.message });
  }
});

// Get user's TradingView linked accounts
app.get('/api/tradingview/accounts/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const user = await resolveUser(username);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json({
      username,
      tradingviewUsername: user.tradingviewUsername,
      liveAlertsEnabled: canAccessTradingViewAlerts(user.subscription),
      subscription: user.subscription,
      tradingview: {
        isOAuthLinked: user.tradingview?.isOAuthLinked || false,
        userId: user.tradingview?.userId,
        linkedAt: user.tradingview?.linkedAt,
        apiAccessLevel: user.tradingview?.apiAccessLevel || 'basic'
      }
    });
  } catch (error) {
    console.error('Get TradingView accounts error:', error);
    res.status(500).json({ message: 'Unable to fetch TradingView accounts', error: error.message });
  }
});

app.get('/api/tradingview/pine-script', requireAuth, requireSubscription, (req, res) => {
  try {
    const generated = PineScriptGeneratorService.generateForUser(req.user, {
      webhookUrl: `${PUBLIC_BACKEND_URL}/api/webhook/tradingview`,
      webhookSecret: TRADINGVIEW_WEBHOOK_SECRET,
      publicBackendUrl: PUBLIC_BACKEND_URL
    });

    res.json({
      script: generated.script,
      webhookUrl: generated.webhookUrl,
      scriptId: generated.scriptId,
      tier: generated.tier,
      tierLabel: generated.tierLabel,
      subscriberLabel: generated.subscriberLabel,
      generatedAt: generated.generatedAt,
      security: generated.security,
      instructions: generated.instructions
    });
  } catch (error) {
    console.error('Pine script error:', error);
    res.status(500).json({ message: 'Unable to generate Pine Script', error: error.message });
  }
});

app.get('/api/tradingview/alerts', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { symbol } = req.query;
    const features = getTierFeatures(req.user.subscription);
    const cutoff = historyCutoffDate(req.user.subscription);
    const filter = { createdAt: { $gte: cutoff } };
    if (symbol) filter.symbol = symbol;

    const limit = symbol ? Math.min(50, features.maxSignals) : features.maxSignals;
    const signals = await Signal.find(filter).sort({ createdAt: -1 }).limit(limit * 2);
    const filtered = filterSignalsForTier(signals, req.user.subscription).slice(0, limit);

    res.json({
      symbol: symbol || null,
      tier: req.user.subscription?.tier || 'basic',
      alerts: filtered.map(s => sanitizeSignalForTier(s, req.user.subscription)),
      count: filtered.length
    });
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ message: 'Unable to fetch alerts', error: error.message });
  }
});

app.get('/api/tradingview/history/:symbol', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { symbol } = req.params;
    const { interval = '1h', limit = 100 } = req.query;
    const features = getTierFeatures(req.user.subscription);

    if (!isCurrencyPairAllowed(symbol, req.user.subscription)) {
      return res.status(403).json({
        message: `Currency pair ${symbol} is not included in your ${getTierDisplayName(req.user.subscription?.tier)} plan.`,
        allowedCurrencyPairs: getAllowedCurrencyPairs(req.user.subscription)
      });
    }

    if (!isTimeframeAllowed(interval, req.user.subscription)) {
      return res.status(403).json({
        message: `Timeframe ${interval} is not included in your ${getTierDisplayName(req.user.subscription?.tier)} plan.`,
        allowedTimeframes: features.timeframes
      });
    }

    const historicalData = await TradingViewService.getHistoricalData(symbol, interval, parseInt(limit, 10));
    const response = { symbol, interval, data: historicalData };

    if (features.newsFilter) {
      response.newsFilterEnabled = true;
    }

    res.json(response);
  } catch (error) {
    console.error('Get historical data error:', error);
    res.status(500).json({ message: 'Unable to fetch historical data', error: error.message });
  }
});

app.get('/api/performance/summary', requireAuth, requireSubscription, requireTierFeature('performanceDashboard'), async (req, res) => {
  try {
    const cutoff = historyCutoffDate(req.user.subscription);
    const signals = isDbReady()
      ? await Signal.find({ createdAt: { $gte: cutoff } }).sort({ createdAt: -1 }).limit(1000).lean()
      : inMemorySignals.filter(s => !s.createdAt || new Date(s.createdAt) >= cutoff);

    const filtered = filterSignalsForTier(signals, req.user.subscription);
    const analytics = buildAnalytics(filtered);

    res.json({
      ...analytics,
      historyDays: getTierFeatures(req.user.subscription).historyDays,
      winRateEstimate: analytics.winRate
    });
  } catch (error) {
    console.error('Performance summary error:', error);
    res.status(500).json({ message: 'Unable to load performance summary', error: error.message });
  }
});

// ===== STRUCTURAL PATTERN SCANNER =====

app.get('/api/scanner/status', (req, res) => {
  res.json(MarketScannerService.getScannerStatus());
});

app.get('/api/scanner/patterns', requireAuth, (req, res) => {
  const allowed = req.user
    ? getAllowedCurrencyPairs(req.user.subscription)
    : require('./config/subscriptions').ALL_CURRENCY_PAIRS;

  res.json({
    patterns: [
      {
        id: 'perfect_fvg',
        name: 'Pattern A: Perfect Fair Value Gap',
        description: '3-candle imbalance gap with displacement middle candle and minimal wicks.'
      },
      {
        id: 'breakaway_gap',
        name: 'Pattern B: Breakaway Gap',
        description: 'Sharp displacement, clean gap on candle 2, confirmed by candle 3 close.'
      }
    ],
    allowedCurrencyPairs: allowed,
    config: require('./config/patternScanner').PATTERN_SCANNER_CONFIG
  });
});

app.post('/api/scanner/candle', async (req, res) => {
  try {
    const auth = await assertTradingViewWebhook(req, res);
    if (!auth) return;

    const { symbol, open, high, low, close, volume, time } = req.body;
    if (!symbol || open == null || high == null || low == null || close == null) {
      return res.status(400).json({ message: 'symbol, open, high, low, close are required' });
    }

    const scanResult = await MarketScannerService.ingestCandle(io, {
      symbol, open, high, low, close, volume, time
    });

    return res.status(201).json({ success: true, scanResult });
  } catch (error) {
    console.error('Scanner candle error:', error);
    return res.status(500).json({ message: 'Scanner candle processing failed', error: error.message });
  }
});

app.post('/api/scanner/run', requireAuth, requireSubscription, requireTierFeature('multiMarketScanner'), async (req, res) => {
  try {
    const { symbol } = req.body;

    if (symbol && !isCurrencyPairAllowed(symbol, req.user.subscription)) {
      return res.status(403).json({
        message: `Currency pair ${symbol} is not included in your plan.`,
        allowedCurrencyPairs: getAllowedCurrencyPairs(req.user.subscription)
      });
    }

    const allowed = getAllowedCurrencyPairs(req.user.subscription);
    const results = symbol
      ? [await MarketScannerService.scanSymbol(io, symbol)]
      : await Promise.all(allowed.map(s => MarketScannerService.scanSymbol(io, s)));
    return res.json({ success: true, results });
  } catch (error) {
    console.error('Scanner run error:', error);
    return res.status(500).json({ message: 'Scanner run failed', error: error.message });
  }
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }

    const payload = verifyToken(token);
    const user = await resolveUserById(payload.userId);

    if (!user) {
      return next(new Error('Invalid session'));
    }

    if (!canAccessLiveAlerts(user.subscription)) {
      return next(new Error('Active subscription required for live alerts'));
    }

    socket.user = user;
    socket.userId = user._id?.toString() || user.id;
    socket.join(`user:${socket.userId}`);
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

io.on('connection', socket => {

  console.log('Subscriber connected:', socket.id, socket.userId);
  socket.emit('subscriber:ready', { userId: socket.userId });

  console.log('Client connected:', socket.id);

  socket.on('tv:subscribe', async ({ appUsername, tradingviewUsername }) => {
    try {
      if (!appUsername || !tradingviewUsername) {
        return;
      }

      const user = await resolveUser(appUsername);
      const normalizedTv = TradingViewAlertService.normalizeTradingViewUsername(tradingviewUsername);
      const linkedTv = TradingViewAlertService.normalizeTradingViewUsername(user?.tradingviewUsername);

      if (!user || linkedTv !== normalizedTv || !canAccessTradingViewAlerts(user.subscription)) {
        socket.emit('tv:subscribe-error', { message: 'Unable to subscribe to live alerts for this TradingView username.' });
        return;
      }

      socket.join(`tv:${normalizedTv}`);
      socket.join(`user:${appUsername}`);
      socket.emit('tv:subscribed', { tradingviewUsername: normalizedTv, appUsername });
    } catch (error) {
      socket.emit('tv:subscribe-error', { message: error.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const defaultPort = parseInt(process.env.PORT, 10) || 4000;
const host = process.env.HOST || '0.0.0.0';
let activePort = defaultPort;
const attemptedPorts = new Set();

function listenOnPort(portToTry) {
  attemptedPorts.add(portToTry);
  server.listen(portToTry, host);
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    const nextPort = activePort + 1;
    if (attemptedPorts.has(nextPort) || nextPort > 65535) {
      console.error(`Unable to start backend: port ${activePort} is in use and no fallback port is available.`);
      process.exit(1);
    }
    console.warn(`Port ${activePort} already in use. Trying fallback port ${nextPort}...`);
    activePort = nextPort;
    listenOnPort(activePort);
    return;
  }
  console.error('Backend server error:', error);
  process.exit(1);
});

listenOnPort(activePort);
server.on('listening', () => {
  console.log(`Backend listening on http://${host}:${activePort}`);
  MarketScannerService.startAutoScanner(io);
  if (TelegramService.isConfigured()) {
    TelegramService.startPolling();
    if (!process.env.TELEGRAM_USE_POLLING) {
      console.log('[Telegram] Bot configured. Set TELEGRAM_USE_POLLING=true for local dev or configure webhook for production.');
    }
  }
});
