const express = require('express');
const http = require('http');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const dotenv = require('dotenv');

dotenv.config();

const {
  assertProductionSecurityConfig,
  sanitizeMongoInput,
  safeErrorMessage,
  verifyPaymentWebhookSecret,
  verifyProviderPaymentWebhook,
  isMockPaymentsAllowed
} = require('./utils/security');
const {
  globalApiLimiter,
  webhookLimiter,
  scannerLimiter,
  tradingViewAuthFailureTracker
} = require('./middleware/rateLimit');
const requireMockPayments = require('./middleware/requireMockPayments');

assertProductionSecurityConfig();

// Fail fast if Strategy Configuration TF layouts are invalid (before Pine generation).
try {
  const {
    assertStrategyArchitecturesValid
  } = require('./strategies/config/strategyArchitecture');
  assertStrategyArchitecturesValid();
} catch (err) {
  console.error('[StrategyArchitecture] Startup validation failed:', err.message);
  if (process.env.NODE_ENV === 'production') {
    throw err;
  }
}

const Signal = require('./models/Signal');
const UserConfig = require('./models/User');

const { TIERS, PAYMENT_CONFIG, getPublicTiers, getTierPricing, FEATURE_MATRIX, getPublicPaymentMethods } = require('./config/subscriptions');

function buildActivationOptions(user, { tier, provider, providerOrderId, providerCustomerId, billingCycle } = {}) {
  const cycle = billingCycle || user?.subscription?.billingCycle || 'monthly';
  const pricing = getTierPricing(tier, cycle);
  return {
    tier,
    provider,
    providerOrderId,
    providerCustomerId,
    billingCycle: pricing.billingCycle,
    periodDays: pricing.periodDays
  };
}

const {
  APP_DOMAIN,
  FRONTEND_URL,
  PUBLIC_BACKEND_URL,
  CORS_ORIGINS,
  WEBHOOK_TRADINGVIEW_URL
} = require('./config/appUrls');
const MpesaService = require('./services/MpesaService');
const PayPalService = require('./services/PayPalService');
const BinanceService = require('./services/BinanceService');
const {
  activateSubscription,
  createPaymentTransaction,
  completePaymentTransaction,
  getPaymentStatus,
  findPaymentByReference
} = require('./services/SubscriptionService');
const ActivationService = require('./services/ActivationService');
const TradingViewService = require('./services/TradingViewService');
const TradingViewAlertService = require('./services/TradingViewAlertService');
const ChartDataService = require('./services/ChartDataService');
const {
  normalizeSignalLevels,
  validateKachingEntrySignal,
  isStructuredEntryAlert
} = require('./utils/kachingSignalLevels');
const {
  logPipeline,
  extractPipelineMeta,
  clientIp,
  payloadSize
} = require('./utils/pipelineLog');
const MarketScannerService = require('./services/MarketScannerService');
const { initMarketDataHub, getMarketDataHub } = require('./services/MarketDataHubService');
const PythonAiService = require('./services/PythonAiService');
const SignalEnrichmentService = require('./services/SignalEnrichmentService');
const SignalOutcomeService = require('./services/SignalOutcomeService');
const WeightLearningService = require('./services/WeightLearningService');
const createAnalyticsRouter = require('./routes/analytics');
const createJournalRouter = require('./routes/journal');
const createTelegramRouter = require('./routes/telegram');
const createMt5Router = require('./routes/mt5');
const PineScriptGeneratorService = require('./services/PineScriptGeneratorService');
const TelegramService = require('./services/TelegramService');
const { buildAnalytics } = require('./utils/signalOutcome');
const {
  isWebhookInsightsSignal,
  legacySourceMongoExclusion
} = require('./utils/insightsSignalFilter');
const { verifyTradingViewWebhook } = require('./utils/webhookSecurity');
const authRoutes = require('./routes/auth');
const referralRoutes = require('./routes/referrals');
const createAdminRouter = require('./routes/admin');
const requireAuth = require('./middleware/requireAuth');
const { resolveUserById } = require('./middleware/requireAuth');
const requireSubscription = require('./middleware/requireSubscription');
const requireTierFeature = require('./middleware/requireTierFeature');
const requireTradingViewAccess = require('./middleware/requireTradingViewAccess');
const validateRequest = require('./middleware/validate');
const { subscribeValidators } = require('./validators/authValidators');
const {
  userCanAccessLiveAlerts,
  userCanAccessTradingViewAlerts,
  withEffectiveAccess,
  getEffectiveSubscription,
  getTierFeatures,
  getTierDisplayName,
  historyCutoffDate,
  sanitizeSignalForTier,
  filterSignalsForTier,
  isCurrencyPairAllowed,
  isTimeframeAllowed,
  getAllowedCurrencyPairs,
  getAllowedTimeframes
} = require('./utils/subscriptionAccess');
const { verifyToken, sanitizeUser } = require('./utils/auth');
const { extractAuthTokenFromSocket } = require('./utils/sessionCookies');
const { isAdmin } = require('./utils/adminAccess');
const { normalizeSymbol } = require('./config/symbols');
const { normalizeInterval } = require('./utils/marketIntervals');
const {
  toUserFacingMarketDataError,
  USER_FACING_MARKET_DATA_UNAVAILABLE
} = require('./utils/marketDataCache');

const TRADINGVIEW_WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || '';

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
  // Prefer per-user licenseToken (HMAC) over legacy shared secret; rate-limit failures.
  const probeBody =
    typeof req.body === 'string'
      ? (() => {
          try {
            return JSON.parse(req.body);
          } catch {
            return {};
          }
        })()
      : req.body || {};
  const meta = extractPipelineMeta(probeBody);

  if (!tradingViewAuthFailureTracker.check(req, res)) {
    logPipeline('Auth', 'FAIL', {
      ...meta,
      reason: 'auth_rate_limited'
    });
    return null;
  }

  const auth = await verifyTradingViewWebhook(req, resolveUserById);
  if (!auth.ok) {
    tradingViewAuthFailureTracker.recordFailure(req);
    const reason = auth.reason || 'unauthorized';
    const bodyMeta = extractPipelineMeta(auth.body || probeBody);
    console.warn(
      `[TV Webhook] Auth rejected (${reason}) symbol=${bodyMeta.symbol || 'n/a'}`
    );
    logPipeline('Auth', 'FAIL', { ...bodyMeta, reason });
    res.status(401).json({
      message: 'Invalid webhook authentication',
      reason
    });
    return null;
  }
  logPipeline('Auth', 'PASS', {
    ...extractPipelineMeta(auth.body || probeBody),
    reason: `mode=${auth.mode || 'ok'}`
  });
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
    symbol: normalizeSymbol(symbol),
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
// Fly / reverse proxies: trust X-Forwarded-For / Fly-Client-IP for rate limits + optional IP checks.
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: true
  }
});
initMarketDataHub(io);

function captureRawBody(req, res, buf) {
  if (buf?.length) {
    req.rawBody = buf;
  }
}

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(cookieParser());
app.use(globalApiLimiter);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});
app.use(express.json({ limit: '1mb', verify: captureRawBody }));
app.use(express.text({ type: ['text/*', 'application/x-www-form-urlencoded'], verify: captureRawBody }));
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeMongoInput(req.body);
  }
  next();
});

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/kachingscanner';
mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'backend',
    dbState: mongoose.connection.readyState,
    domain: APP_DOMAIN,
    frontendUrl: FRONTEND_URL,
    publicBackendUrl: PUBLIC_BACKEND_URL,
    architecture: 'tradingview_webhook_distribution',
    pythonAi: {
      configured: PythonAiService.isConfigured(),
      url: PythonAiService.isConfigured() ? PythonAiService.getPythonServiceUrl() : null
    }
  });
});

// Auth routes apply per-endpoint limiters (login/register vs email vs token redeem).
// Do not blanket-limit /api/auth — /me and /logout must not consume auth-attempt budget.
app.use('/api/auth', authRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/admin', createAdminRouter({ io }));

const inMemorySignals = [];

app.use('/api/analytics', createAnalyticsRouter({ inMemorySignals, isDbReady }));
app.use('/api/journal', createJournalRouter());
app.use('/api/telegram', createTelegramRouter());
app.use('/api/mt5', createMt5Router());

app.post('/api/signals', webhookLimiter, async (req, res) => {
  try {
    const auth = await assertTradingViewWebhook(req, res);
    if (!auth) return;

    // Publish-only: never enrich with live market data on TradingView inject paths.
    const result = await MarketScannerService.publishTradingViewAlert(
      io,
      auth.body || req.body,
      inMemorySignals
    );

    return res.status(201).json({
      success: true,
      publishOnly: true,
      ...result
    });
  } catch (error) {
    console.error('Error saving signal:', error);
    return res.status(400).json({ message: safeErrorMessage(error, 'Unable to save signal.') });
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

app.post('/api/webhook/tradingview', webhookLimiter, async (req, res) => {
  const t0 = Date.now();
  // STEP 4 — log BEFORE auth so silent upstream drops are visible in Fly/local logs.
  const earlyBody =
    typeof req.body === 'string'
      ? (() => {
          try {
            return JSON.parse(req.body);
          } catch {
            return {};
          }
        })()
      : req.body && typeof req.body === 'object'
        ? req.body
        : {};
  const earlyMeta = extractPipelineMeta(earlyBody);
  const size = payloadSize(req);
  const ip = clientIp(req);
  console.log(
    `[TV WEBHOOK RECEIVED] timestamp=${new Date().toISOString()} ip=${ip} ` +
      `symbol=${earlyMeta.symbol || 'n/a'} timeframe=${earlyMeta.timeframe || 'n/a'} ` +
      `signalUuid=${earlyMeta.signalUuid || 'n/a'} payloadBytes=${size}`
  );
  logPipeline('WebhookReceived', 'PASS', {
    ...earlyMeta,
    reason: `ip=${ip}; bytes=${size}`
  });

  try {
    const auth = await assertTradingViewWebhook(req, res);
    if (!auth) return;

    // Prefer auth.body (already JSON-parsed) so text/plain TV posts are not re-parsed incorrectly.
    const rawPayload = auth.body || req.body;
    const parsed = TradingViewAlertService.parseWebhookBody(rawPayload);
    const meta = extractPipelineMeta(parsed);
    const normalizedAlertType = TradingViewAlertService.normalizeAlertType(
      parsed.alertType || parsed.alert_type || parsed.type
    );
    const structuredProbe = { ...parsed, alertType: normalizedAlertType };
    const isStructuredEntry = isStructuredEntryAlert(structuredProbe);
    const isCandleFeed = normalizedAlertType === 'candle' || parsed.pattern === 'feed';
    const isCandlePayload =
      !isStructuredEntry &&
      parsed.open != null &&
      parsed.high != null &&
      parsed.low != null &&
      parsed.close != null;

    // Candle feeds are acknowledged only — no ingest, scan, indicators, or live market-data fetch.
    // Must not swallow structured entries (e.g. liquidity_sweep_*) that also include OHLC fields.
    if ((isCandlePayload || isCandleFeed) && parsed.symbol && !isStructuredEntry) {
      console.log(
        `[TV Webhook] Candle feed acknowledged (no scan/fetch): ${parsed.symbol || parsed.ticker}`
      );
      logPipeline('CandleAck', 'PASS', {
        ...meta,
        reason: 'candle_feed_no_signal_publish'
      });
      return res.status(201).json({
        success: true,
        mode: 'candle_ack',
        publishOnly: true,
        scanned: false,
        fetched: false
      });
    }

    logPipeline('Validation', 'PASS', {
      ...meta,
      reason: `alertType=${normalizedAlertType}; structuredEntry=${isStructuredEntry}`
    });

    const result = await MarketScannerService.publishTradingViewAlert(
      io,
      rawPayload,
      inMemorySignals
    );

    const latencyMs = Date.now() - t0;
    if (result?.rejected) {
      logPipeline('Publish', 'FAIL', {
        ...meta,
        signalUuid: result.signalUuid || meta.signalUuid,
        reason: result.reason || 'rejected'
      });
    } else {
      logPipeline('Publish', 'PASS', {
        ...meta,
        signalUuid: result.signalUuid || meta.signalUuid,
        reason: `mode=${result.mode || 'broadcast'}; delivered=${result.delivered ?? 0}; latencyMs=${latencyMs}`
      });
    }

    return res.status(201).json({ success: true, latencyMs, ...result });
  } catch (error) {
    const rejectedFields =
      error?.rejectedFields ||
      (error?.message && /missing/i.test(error.message) ? error.message : null);
    logPipeline('Validation', 'FAIL', {
      ...earlyMeta,
      reason: rejectedFields || error.message || 'webhook_processing_failed'
    });
    console.error('TradingView webhook error:', error);
    return res.status(500).json({
      message: 'TradingView webhook processing failed',
      error: error.message,
      rejectedFields: rejectedFields || undefined
    });
  }
});

/**
 * Dev-only: POST one valid entry through the REAL /api/webhook/tradingview production path.
 * Never enabled in production. Set ENABLE_PIPELINE_SELF_TEST=true to expose.
 */
app.post('/api/dev/pipeline-self-test', async (req, res) => {
  if (process.env.NODE_ENV === 'production' || process.env.ENABLE_PIPELINE_SELF_TEST !== 'true') {
    return res.status(404).json({ message: 'Not found' });
  }

  try {
    const { runPipelineSelfTest } = require('./utils/pipelineSelfTest');
    const report = await runPipelineSelfTest({
      io,
      inMemorySignals
    });
    return res.status(report.ok ? 200 : 500).json(report);
  } catch (error) {
    console.error('[PipelineSelfTest] failed:', error);
    return res.status(500).json({ ok: false, error: error.message });
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
      createdAt: { $gte: cutoff },
      ...legacySourceMongoExclusion()
    })
      .sort({ createdAt: -1 })
      .limit(features.maxSignals * 5);

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
      ? await Signal.find({
          createdAt: { $gte: cutoff },
          ...legacySourceMongoExclusion()
        })
          .sort({ createdAt: -1 })
          .limit(limit * 5)
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
  res.json({
    tiers: getPublicTiers(),
    featureMatrix: FEATURE_MATRIX,
    paymentMethods: getPublicPaymentMethods()
  });
});

app.post('/api/subscribe', requireAuth, subscribeValidators, validateRequest, async (req, res) => {
  try {
    const { tier, provider, phone, billingCycle = 'monthly' } = req.body;
    const userId = req.userId;
    const pricing = getTierPricing(tier, billingCycle);
    const pendingSubscription = {
      tier,
      status: 'pending',
      provider,
      billingCycle: pricing.billingCycle
    };

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
      if (!isMockPaymentsAllowed()) {
        return res.status(404).json({ message: 'Not found' });
      }
      const mockPaymentId = `mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      user = await UserConfig.findByIdAndUpdate(
        userId,
        {
          phone: phone || user.phone,
          subscription: {
            ...pendingSubscription,
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
            ...pendingSubscription,
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
        if (!isMockPaymentsAllowed()) {
          return res.status(503).json({
            message: 'M-Pesa is not configured for live payments. Please use PayPal or another available method.'
          });
        }
        stkResult = {
          checkoutRequestId: `stk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          merchantRequestId: `mr_${Date.now()}`,
          customerMessage: 'Mock STK push — configure M-Pesa credentials for live payments'
        };
      } else {
        stkResult = await MpesaService.initiateStkPush({
          phone,
          amount: pricing.price,
          accountReference: userId,
          description: `KachingFx ${tierConfig.name} (${pricing.periodLabel})`
        });
      }

      await createPaymentTransaction({
        userId,
        tier,
        provider: 'mpesa',
        amount: pricing.price,
        currency: pricing.currency,
        providerReference: stkResult.checkoutRequestId,
        merchantRequestId: stkResult.merchantRequestId
      });

      user = await UserConfig.findByIdAndUpdate(
        userId,
        {
          phone,
          subscription: {
            ...pendingSubscription,
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
            ...pendingSubscription,
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
        amount: pricing.price,
        billingCycle: pricing.billingCycle,
        tillNumber: PAYMENT_CONFIG.mpesa.shortcode,
        mockMode: isMockPaymentsAllowed() && (PAYMENT_CONFIG.mode === 'mock' || !MpesaService.isConfigured())
      });
    }

    if (provider === 'paypal') {
      const tierConfig = TIERS[tier];
      const frontendUrl = FRONTEND_URL;
      const returnUrlBase = PAYMENT_CONFIG.paypal.returnUrlBase || `${PUBLIC_BACKEND_URL}/api/payments/paypal/return`;
      const returnUrl = `${returnUrlBase}?tier=${encodeURIComponent(tier)}&billingCycle=${encodeURIComponent(pricing.billingCycle)}`;
      const cancelUrl = `${frontendUrl}?paypal=cancelled`;

      let orderResult;

      if (PAYMENT_CONFIG.mode === 'mock' || !PayPalService.isConfigured()) {
        if (!isMockPaymentsAllowed()) {
          return res.status(503).json({
            message: 'PayPal is not configured for live payments. Please try another available method.'
          });
        }
        const mockOrderId = `paypal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        orderResult = {
          orderId: mockOrderId,
          approveUrl: `${frontendUrl}?paypal=mock&orderId=${mockOrderId}&tier=${tier}&billingCycle=${pricing.billingCycle}`
        };
      } else {
        orderResult = await PayPalService.createOrder({
          tier,
          userId: userId.toString(),
          returnUrl,
          cancelUrl,
          billingCycle: pricing.billingCycle
        });
      }

      await createPaymentTransaction({
        userId,
        tier,
        provider: 'paypal',
        amount: pricing.priceCents / 100,
        currency: pricing.currencyPayPal,
        billingCycle: pricing.billingCycle,
        providerReference: orderResult.orderId
      });

      user = await UserConfig.findByIdAndUpdate(
        userId,
        {
          subscription: {
            ...pendingSubscription,
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
            ...pendingSubscription,
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
        amount: pricing.priceCents / 100,
        currency: pricing.currencyPayPal,
        billingCycle: pricing.billingCycle,
        mockMode: isMockPaymentsAllowed() && (PAYMENT_CONFIG.mode === 'mock' || !PayPalService.isConfigured())
      });
    }

    if (provider === 'binance') {
      const tierConfig = TIERS[tier];
      let orderResult;

      if (PAYMENT_CONFIG.mode === 'mock' || !BinanceService.isConfigured()) {
        if (!isMockPaymentsAllowed()) {
          return res.status(503).json({
            message: 'Binance Pay is not configured for live payments. Please use PayPal or another available method.'
          });
        }
        const mockTradeNo = `binance_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`.slice(0, 32);
        orderResult = {
          merchantTradeNo: mockTradeNo,
          prepayId: mockTradeNo,
          checkoutUrl: `${FRONTEND_URL}?binance=mock&merchantTradeNo=${mockTradeNo}&tier=${tier}&billingCycle=${pricing.billingCycle}`,
          amount: pricing.priceCents / 100,
          currency: pricing.currencyBinance || 'USDT'
        };
      } else {
        orderResult = await BinanceService.createOrder({
          tier,
          userId: userId.toString(),
          billingCycle: pricing.billingCycle
        });
      }

      await createPaymentTransaction({
        userId,
        tier,
        provider: 'binance',
        amount: orderResult.amount,
        currency: orderResult.currency,
        providerReference: orderResult.merchantTradeNo,
        merchantRequestId: orderResult.prepayId
      });

      user = await UserConfig.findByIdAndUpdate(
        userId,
        {
          subscription: {
            ...pendingSubscription,
            provider: 'binance',
            providerOrderId: orderResult.merchantTradeNo
          },
          updatedAt: new Date()
        },
        { new: true }
      );

      if (!user && !isDbReady()) {
        user = devUserStore.upsertUser(userId, {
          subscription: {
            ...pendingSubscription,
            provider: 'binance',
            providerOrderId: orderResult.merchantTradeNo
          }
        });
      }

      return res.json({
        success: true,
        message: 'Binance Pay checkout created',
        user: sanitizeUser(user),
        checkoutId: orderResult.merchantTradeNo,
        merchantTradeNo: orderResult.merchantTradeNo,
        checkoutUrl: orderResult.checkoutUrl,
        amount: orderResult.amount,
        currency: orderResult.currency,
        billingCycle: pricing.billingCycle,
        mockMode: isMockPaymentsAllowed() && (PAYMENT_CONFIG.mode === 'mock' || !BinanceService.isConfigured()),
        merchantId: PAYMENT_CONFIG.binance.merchantId || null
      });
    }

    return res.status(400).json({ message: 'Unsupported payment provider.' });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ message: 'Unable to initiate subscription', error: error.message });
  }
});


app.get('/api/subscription/me', requireAuth, (req, res) => {
  const subscription = getEffectiveSubscription(req.user);
  const tier = subscription?.tier || 'basic';
  res.json({
    user: sanitizeUser(req.user),
    subscription,
    tierFeatures: getTierFeatures(subscription),
    tierDisplayName: subscription.adminBypass
      ? subscription.planLabel || 'Administrator'
      : getTierDisplayName(tier),
    allowedCurrencyPairs: getAllowedCurrencyPairs(subscription),
    allowedTimeframes: getAllowedTimeframes(subscription)
  });
});

/** Manual M-Pesa Till — user submits "I Have Paid" (pending verification, no access yet). */
app.post('/api/payments/manual/submit', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await ActivationService.submitManualPaymentRequest({
      userId: req.userId,
      tier: body.tier || body.planId,
      billingCycle: body.billingCycle,
      mpesaCode: body.mpesaCode || body.paymentReference,
      phoneNumber: body.phoneNumber || body.phone,
      amount: body.amount,
      notes: body.notes,
      screenshotUrl: body.screenshotUrl || body.screenshot
    });
    res.status(201).json({
      message: 'Payment submitted. Awaiting verification.',
      status: 'pending',
      payment: {
        id: String(result.payment._id),
        status: result.payment.status,
        mpesaCode: result.payment.providerReference,
        amount: result.payment.amount,
        currency: result.payment.currency,
        tier: result.payment.tier,
        createdAt: result.payment.createdAt
      },
      subscription: result.subscription,
      user: sanitizeUser(result.user)
    });
  } catch (error) {
    console.error('Manual payment submit error:', error);
    res.status(error.status || 500).json({
      message: error.message || 'Unable to submit payment.'
    });
  }
});

app.get('/api/payments/manual/mine', requireAuth, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ payments: [] });
    }
    const PaymentTransaction = require('./models/PaymentTransaction');
    const rows = await PaymentTransaction.find({
      userId: req.userId,
      $or: [{ provider: 'manual_mpesa' }, { paymentMethod: 'manual_mpesa' }]
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json({
      payments: rows.map(row => ({
        id: String(row._id),
        status: row.status,
        tier: row.tier,
        amount: row.amount,
        currency: row.currency,
        mpesaCode: row.providerReference,
        phoneNumber: row.phoneNumber,
        notes: row.notes || '',
        createdAt: row.createdAt,
        activationDate: row.activationDate || null,
        completedAt: row.completedAt || null
      }))
    });
  } catch (error) {
    console.error('Manual payment list error:', error);
    res.status(500).json({ message: 'Unable to load payment requests.' });
  }
});

app.post('/api/payments/mock/confirm', requireAuth, requireMockPayments, async (req, res) => {
  try {
    const { paymentId, tier, billingCycle } = req.body;

    if (!paymentId || !tier) {
      return res.status(400).json({ message: 'paymentId and tier are required' });
    }

    const transaction = await getPaymentStatus(paymentId, 'mock', req.userId);
    if (!transaction || transaction.status !== 'pending') {
      return res.status(400).json({ message: 'No pending mock payment found for this account.' });
    }

    const completed = await completePaymentTransaction(paymentId, 'mock', { rawPayload: { mock: true } });
    if (!completed || completed.status !== 'completed') {
      return res.status(400).json({ message: 'Unable to complete mock payment.' });
    }

    const user = await activateSubscription(
      req.userId,
      buildActivationOptions(req.user, {
        tier: transaction.tier || tier,
        provider: 'mock',
        providerOrderId: paymentId,
        billingCycle: billingCycle || transaction.billingCycle
      }),
      io
    );

    res.json({
      success: true,
      message: 'Subscription activated.',
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error('Mock payment confirm error:', error);
    res.status(500).json({ message: safeErrorMessage(error, 'Unable to confirm mock payment.') });
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

app.post('/api/payments/mpesa/mock-complete', requireAuth, requireMockPayments, async (req, res) => {
  try {
    const { checkoutRequestId, tier, billingCycle } = req.body;

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
      buildActivationOptions(req.user, {
        tier,
        provider: 'mpesa',
        providerOrderId: checkoutRequestId,
        billingCycle
      }),
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
  const frontendUrl = FRONTEND_URL;

  try {
    const { token: orderId, tier, billingCycle } = req.query;

    if (!orderId) {
      return res.redirect(`${frontendUrl}?paypal=error&message=missing_order`);
    }

    const existing = await findPaymentByReference(String(orderId), 'paypal');
    if (existing?.status === 'completed') {
      return res.redirect(`${frontendUrl}?paypal=success&tier=${encodeURIComponent(existing.tier || tier || 'basic')}`);
    }

    const captureResult = await PayPalService.captureOrder(orderId);
    const captureStatus = String(captureResult.status || '').toUpperCase();
    if (captureStatus && captureStatus !== 'COMPLETED') {
      return res.redirect(`${frontendUrl}?paypal=error&message=payment_not_completed`);
    }

    const customId = PayPalService.extractCustomId(captureResult);
    const [customUserId, capturedTier, capturedBillingCycle] = (customId || '').split(':');
    const resolvedUserId = customUserId || existing?.userId?.toString();
    const resolvedTier = tier || capturedTier || existing?.tier || 'basic';
    const resolvedBillingCycle = billingCycle || capturedBillingCycle || 'monthly';

    await completePaymentTransaction(orderId, 'paypal', { rawPayload: captureResult });

    if (resolvedUserId) {
      const payer = await UserConfig.findById(resolvedUserId);
      await activateSubscription(
        resolvedUserId,
        buildActivationOptions(payer, {
          tier: resolvedTier,
          provider: 'paypal',
          providerOrderId: orderId,
          billingCycle: resolvedBillingCycle
        }),
        io
      );
    }

    return res.redirect(`${frontendUrl}?paypal=success&tier=${encodeURIComponent(resolvedTier)}`);
  } catch (error) {
    console.error('PayPal return error:', error);
    return res.redirect(`${frontendUrl}?paypal=error&message=payment_failed`);
  }
});

app.post('/api/payments/paypal/mock-complete', requireAuth, requireMockPayments, async (req, res) => {
  try {
    const { orderId, tier, billingCycle } = req.body;

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
      buildActivationOptions(req.user, {
        tier,
        provider: 'paypal',
        providerOrderId: orderId,
        billingCycle
      }),
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

app.get('/api/payments/binance/status/:merchantTradeNo', requireAuth, async (req, res) => {
  try {
    const { merchantTradeNo } = req.params;
    const transaction = await getPaymentStatus(merchantTradeNo, 'binance', req.userId);

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
    console.error('Binance status error:', error);
    res.status(500).json({ message: 'Unable to check payment status', error: error.message });
  }
});

app.get('/api/payments/binance/return', async (req, res) => {
  const frontendUrl = FRONTEND_URL;

  try {
    const { merchantTradeNo } = req.query;
    if (!merchantTradeNo) {
      return res.redirect(`${frontendUrl}?binance=error&message=missing_order`);
    }

    const transaction = await findPaymentByReference(String(merchantTradeNo), 'binance');
    if (!transaction) {
      return res.redirect(`${frontendUrl}?binance=error&message=unknown_order`);
    }

    if (transaction.status === 'completed') {
      return res.redirect(`${frontendUrl}?binance=success&tier=${transaction.tier}`);
    }

    if (BinanceService.isConfigured() && PAYMENT_CONFIG.mode !== 'mock') {
      const orderData = await BinanceService.queryOrder(String(merchantTradeNo));
      if (BinanceService.isPaidStatus(orderData)) {
        await completePaymentTransaction(String(merchantTradeNo), 'binance', { rawPayload: orderData });
        const payer = await UserConfig.findById(transaction.userId);
        await activateSubscription(
          transaction.userId,
          buildActivationOptions(payer, {
            tier: transaction.tier,
            provider: 'binance',
            providerOrderId: String(merchantTradeNo),
            billingCycle: payer?.subscription?.billingCycle
          }),
          io
        );
        return res.redirect(`${frontendUrl}?binance=success&tier=${transaction.tier}`);
      }
    }

    return res.redirect(`${frontendUrl}?binance=pending&merchantTradeNo=${encodeURIComponent(String(merchantTradeNo))}`);
  } catch (error) {
    console.error('Binance return error:', error);
    return res.redirect(`${frontendUrl}?binance=error&message=${encodeURIComponent(error.message)}`);
  }
});

app.post('/api/payments/binance/mock-complete', requireAuth, requireMockPayments, async (req, res) => {
  try {
    const { merchantTradeNo, tier, billingCycle } = req.body;

    if (!merchantTradeNo || !tier) {
      return res.status(400).json({ message: 'merchantTradeNo and tier are required' });
    }

    const transaction = await getPaymentStatus(merchantTradeNo, 'binance', req.userId);
    if (!transaction || transaction.status !== 'pending') {
      return res.status(400).json({ message: 'No pending Binance Pay payment found' });
    }

    await completePaymentTransaction(merchantTradeNo, 'binance', { rawPayload: { mock: true } });

    const user = await activateSubscription(
      req.userId,
      buildActivationOptions(req.user, {
        tier,
        provider: 'binance',
        providerOrderId: merchantTradeNo,
        billingCycle
      }),
      io
    );

    res.json({
      success: true,
      message: 'Binance Pay payment confirmed (mock mode)',
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error('Binance mock complete error:', error);
    res.status(500).json({ message: 'Unable to confirm Binance Pay payment', error: error.message });
  }
});

app.get('/api/subscription/:username', requireAuth, async (req, res) => {
  try {
    const { username } = req.params;
    const user = await resolveUser(username);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const requesterId = String(req.userId);
    const ownerId = String(user._id || user.id);
    if (requesterId !== ownerId && !isAdmin(req.user)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    res.json({
      username,
      subscription: getEffectiveSubscription(user)
    });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ message: safeErrorMessage(error, 'Unable to fetch subscription.') });
  }
});

app.post('/api/webhook/mpesa', webhookLimiter, async (req, res) => {
  try {
    const auth = verifyProviderPaymentWebhook(req, 'mpesa');
    if (!auth.ok) {
      console.warn('M-Pesa webhook rejected:', auth.reason, auth.ip || '');
      // Do not activate subscriptions on unauthenticated callbacks.
      return res.status(401).json({ ResultCode: 1, ResultDesc: 'Unauthorized' });
    }

    console.log('M-Pesa webhook received:', JSON.stringify(req.body));
    const callback = MpesaService.parseStkCallback(req.body);

    if (!callback) {
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    const transaction = await findPaymentByReference(callback.checkoutRequestId, 'mpesa');

    if (!transaction) {
      console.warn('M-Pesa callback for unknown transaction:', callback.checkoutRequestId);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
    }

    if (callback.resultCode === 0) {
      await completePaymentTransaction(callback.checkoutRequestId, 'mpesa', { rawPayload: callback });
      const payer = await UserConfig.findById(transaction.userId);
      await activateSubscription(
        transaction.userId,
        buildActivationOptions(payer, {
          tier: transaction.tier,
          provider: 'mpesa',
          providerOrderId: callback.checkoutRequestId,
          providerCustomerId: callback.mpesaReceiptNumber
        }),
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

app.post('/api/webhook/paypal', webhookLimiter, async (req, res) => {
  try {
    const verification = await PayPalService.verifyWebhookSignature(req);
    if (!verification.ok) {
      console.warn('PayPal webhook rejected:', verification.reason);
      return res.status(verification.reason === 'paypal_not_configured' ? 503 : 401).json({
        message: 'Invalid PayPal webhook signature'
      });
    }

    console.log('PayPal webhook received:', req.body?.event_type);
    const { eventType, customId, orderId } = PayPalService.parseWebhookEvent(req.body);

    if (eventType === 'PAYMENT.CAPTURE.COMPLETED' || eventType === 'CHECKOUT.ORDER.APPROVED') {
      const [userId, tier, billingCycle] = (customId || '').split(':');

      if (orderId) {
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
          const resolvedUserId = userId || existing.userId?.toString();
          if (resolvedUserId) {
            const payer = await UserConfig.findById(resolvedUserId);
            await activateSubscription(
              resolvedUserId,
              buildActivationOptions(payer, {
                tier: tier || existing.tier,
                provider: 'paypal',
                providerOrderId: orderId,
                billingCycle: billingCycle || existing.billingCycle
              }),
              io
            );
          }
        }
      }
    }

    res.status(200).json({ status: 'received' });
  } catch (error) {
    console.error('PayPal webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/webhook/binance', async (req, res) => {
  try {
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), value])
    );

    if (!BinanceService.isConfigured()) {
      console.warn('Binance Pay webhook rejected: provider not configured');
      return res.status(503).json({ returnCode: 'FAIL', returnMessage: 'Provider not configured' });
    }

    if (!BinanceService.verifyWebhookSignature(rawBody, headers)) {
      console.warn('Binance Pay webhook signature verification failed');
      return res.status(401).json({ returnCode: 'FAIL', returnMessage: 'Invalid signature' });
    }

    const event = BinanceService.parseWebhookEvent(req.body);
    console.log('Binance Pay webhook received:', event.bizStatus, event.merchantTradeNo);

    if (event.bizStatus === 'PAY_SUCCESS' && event.merchantTradeNo) {
      const transaction = await findPaymentByReference(event.merchantTradeNo, 'binance');
      if (transaction && transaction.status === 'pending') {
        await completePaymentTransaction(event.merchantTradeNo, 'binance', { rawPayload: req.body });
        const payer = await UserConfig.findById(transaction.userId);
        const passThrough = String(event.passThroughInfo || '').split(':');
        await activateSubscription(
          transaction.userId,
          buildActivationOptions(payer, {
            tier: passThrough[1] || transaction.tier,
            provider: 'binance',
            providerOrderId: event.merchantTradeNo,
            providerCustomerId: event.transactionId,
            billingCycle: passThrough[2] || payer?.subscription?.billingCycle
          }),
          io
        );
      }
    } else if (event.bizStatus === 'PAY_CLOSED' && event.merchantTradeNo) {
      await completePaymentTransaction(event.merchantTradeNo, 'binance', {
        rawPayload: req.body,
        failureReason: 'Payment closed without completion'
      });
    }

    res.status(200).json({ returnCode: 'SUCCESS', returnMessage: null });
  } catch (error) {
    console.error('Binance Pay webhook error:', error);
    res.status(500).json({ returnCode: 'FAIL', returnMessage: error.message });
  }
});

app.post('/api/webhook/payments', webhookLimiter, async (req, res) => {
  try {
    if (!verifyPaymentWebhookSecret(req)) {
      return res.status(401).json({ message: 'Invalid payment webhook authentication' });
    }

    const { event, provider, userId, tier, status } = req.body;

    if (!userId || !provider) {
      return res.status(400).json({ message: 'userId and provider are required' });
    }

    const PaymentTransaction = require('./models/PaymentTransaction');
    const providerReference = req.body.providerReference || req.body.paymentId || req.body.orderId;
    if (!providerReference) {
      return res.status(400).json({ message: 'providerReference is required' });
    }

    const transaction = await findPaymentByReference(providerReference, provider);
    if (!transaction || String(transaction.userId) !== String(userId)) {
      return res.status(404).json({ message: 'Payment transaction not found' });
    }

    if (status === 'success' || event === 'payment.completed') {
      if (transaction.status !== 'pending') {
        return res.json({ success: true, message: 'Payment already processed' });
      }

      await completePaymentTransaction(providerReference, provider, { rawPayload: req.body });
      const payer = await UserConfig.findById(userId);
      const user = await activateSubscription(
        userId,
        buildActivationOptions(payer, {
          tier: tier || transaction.tier || 'basic',
          provider,
          providerOrderId: providerReference
        }),
        io
      );

      io.emit('subscription:updated', { userId, subscription: user.subscription });
      return res.json({ success: true, message: 'Subscription activated' });
    }

    if (status === 'cancelled' || event === 'payment.cancelled') {
      await completePaymentTransaction(providerReference, provider, {
        rawPayload: req.body,
        failureReason: 'Payment cancelled'
      });
      return res.json({ success: true, message: 'Payment cancelled' });
    }

    res.json({ message: 'Event processed' });
  } catch (error) {
    console.error('Payment webhook error:', error);
    res.status(500).json({ message: safeErrorMessage(error, 'Webhook processing error.') });
  }
});


// ===== TRADINGVIEW SETUP (subscribers use TradingView as alert front-end) =====

app.get('/api/tradingview/setup', requireAuth, requireSubscription, (req, res) => {
  const { sampleWebhookPayload, resolveTradingViewUsername } = require('./services/PineScriptGeneratorService');
  const tradingviewUsername = resolveTradingViewUsername(req.user);
  res.json({
    liveAlertsEnabled: true,
    architecture: 'tradingview_webhook_distribution',
    flow: 'TradingView → webhook → Kaching dashboard / Telegram / MT5',
    webhookUrl: WEBHOOK_TRADINGVIEW_URL,
    tradingviewUsername: tradingviewUsername || null,
    requiresTradingViewUsername: !tradingviewUsername,
    samplePayload: sampleWebhookPayload(),
    chartProvidersNote:
      'Charts are display-only. Chart feed issues do not affect alerts and never generate trades.',
    subscription: req.user.subscription,
    instructions: [
      'Link your TradingView username on the TradingView Setup tab (required before your personal script can be generated).',
      'Copy your personal script from the TradingView Setup tab and add it to a TradingView chart. In script settings, confirm the same TradingView username.',
      `Create one alert for that script, enable webhook notifications, and paste: ${WEBHOOK_TRADINGVIEW_URL}`,
      'When TradingView fires, Kaching publishes Entry, stop loss, and take-profit levels to this dashboard, Telegram, and MT5.',
      'Your script is licensed to your TradingView username — it will not send valid alerts from another TradingView account.',
      'Optional: turn on TradingView push or email so you also get notified on your phone.',
      'Charts are separate from alerts — chart feed outages never block trade delivery.'
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
    res.redirect(`${FRONTEND_URL}?tradingview_linked=true&username=${encodeURIComponent(username)}`);
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ message: 'OAuth callback failed', error: error.message });
  }
});

// Link TradingView account by username (username-based, no OAuth)
app.post('/api/tradingview/link', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { tradingviewUsername } = req.body;

    if (!tradingviewUsername) {
      return res.status(400).json({ message: 'tradingviewUsername is required' });
    }

    const normalizedTv = TradingViewAlertService.normalizeTradingViewUsername(tradingviewUsername);
    if (!normalizedTv) {
      return res.status(400).json({ message: 'Enter a valid TradingView username.' });
    }

    if (!isDbReady()) {
      const store = require('./utils/devUserStore');
      const taken = store.listActiveSubscribers().find(u => {
        const otherId = String(u.id || u._id || '');
        const otherTv = TradingViewAlertService.normalizeTradingViewUsername(u.tradingviewUsername);
        return otherTv === normalizedTv && otherId && otherId !== String(req.userId);
      });
      if (taken) {
        return res.status(409).json({ message: 'This TradingView username is already linked to another account.' });
      }
      const user = store.upsertUser(req.userId, { tradingviewUsername: normalizedTv });
      return res.json({
        success: true,
        message: 'TradingView account linked. Re-copy your personal Pine script to refresh the license.',
        tradingviewUsername: user.tradingviewUsername
      });
    }

    const existing = await UserConfig.findOne({
      tradingviewUsername: { $regex: new RegExp(`^${normalizedTv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      _id: { $ne: req.userId }
    });

    if (existing) {
      return res.status(409).json({ message: 'This TradingView username is already linked to another account.' });
    }

    const user = await UserConfig.findByIdAndUpdate(
      req.userId,
      {
        tradingviewUsername: normalizedTv,
        updatedAt: new Date()
      },
      { new: true }
    );

    res.json({
      success: true,
      message: 'TradingView account linked. Re-copy your personal Pine script to refresh the license.',
      tradingviewUsername: user.tradingviewUsername
    });
  } catch (error) {
    console.error('TradingView link error:', error);
    res.status(500).json({ message: safeErrorMessage(error, 'Unable to link TradingView account.') });
  }
});

// Get user's TradingView linked accounts
app.get('/api/tradingview/accounts/:username', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { username } = req.params;
    const user = await resolveUser(username);

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const requesterId = String(req.userId);
    const ownerId = String(user._id || user.id);
    if (requesterId !== ownerId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    res.json({
      username,
      tradingviewUsername: user.tradingviewUsername,
      liveAlertsEnabled: userCanAccessTradingViewAlerts(user),
      subscription: getEffectiveSubscription(user)
    });
  } catch (error) {
    console.error('Get TradingView accounts error:', error);
    res.status(500).json({ message: safeErrorMessage(error, 'Unable to fetch TradingView accounts.') });
  }
});

app.get('/api/tradingview/pine-script', requireAuth, requireSubscription, (req, res) => {
  try {
    const generated = PineScriptGeneratorService.generateForUser(req.user, {
      webhookUrl: WEBHOOK_TRADINGVIEW_URL,
      webhookSecret: TRADINGVIEW_WEBHOOK_SECRET,
      publicBackendUrl: PUBLIC_BACKEND_URL,
      strategy: req.query.strategy || req.query.strategyId
    });

    res.json({
      script: generated.script,
      webhookUrl: generated.webhookUrl,
      scriptId: generated.scriptId,
      tier: generated.tier,
      tierLabel: generated.tierLabel,
      subscriberLabel: generated.subscriberLabel,
      tradingviewUsername: generated.tradingviewUsername,
      strategy: generated.strategy,
      strategyName: generated.strategyName,
      availableStrategies: generated.availableStrategies,
      generatedAt: generated.generatedAt,
      architecture: generated.architecture,
      flow: generated.flow,
      samplePayload: generated.samplePayload,
      security: generated.security,
      instructions: generated.instructions
    });
  } catch (error) {
    if (error.code === 'tradingview_username_required') {
      return res.status(400).json({
        message: error.message,
        code: error.code,
        requiresTradingViewUsername: true
      });
    }
    console.error('Pine script error:', error);
    res.status(500).json({ message: 'Unable to generate Pine Script', error: error.message });
  }
});

app.get('/api/tradingview/alerts', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { symbol } = req.query;
    const features = getTierFeatures(req.user.subscription);
    const cutoff = historyCutoffDate(req.user.subscription);
    const filter = {
      createdAt: { $gte: cutoff },
      ...legacySourceMongoExclusion()
    };
    const requestedSymbol =
      symbol && String(symbol).toUpperCase() !== 'ALL' ? normalizeSymbol(symbol) : null;

    const limit = requestedSymbol ? Math.min(50, features.maxSignals) : features.maxSignals;
    const signals = await Signal.find(filter).sort({ createdAt: -1 }).limit(limit * 5);
    const filtered = filterSignalsForTier(signals, req.user.subscription)
      .filter(s => !requestedSymbol || normalizeSymbol(s.symbol) === requestedSymbol)
      .slice(0, limit);

    res.json({
      symbol: requestedSymbol || null,
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
    const { interval: rawInterval = '1h', limit = 100 } = req.query;
    const interval = normalizeInterval(rawInterval);
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

    const historicalData = await ChartDataService.getHistoricalData(symbol, interval, parseInt(limit, 10));
    const response = { symbol, interval, data: historicalData };

    if (features.newsFilter) {
      response.newsFilterEnabled = true;
    }

    res.json(response);
  } catch (error) {
    console.error('Get historical data error:', error);
    res.status(500).json({
      message: toUserFacingMarketDataError(error.message, 'Unable to fetch historical data')
    });
  }
});

app.get('/api/market-data/candles', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { symbol, interval: rawInterval = '1h', limit = 200 } = req.query;
    const interval = normalizeInterval(rawInterval);
    if (!symbol) {
      return res.status(400).json({ message: 'symbol query parameter is required' });
    }

    if (!isCurrencyPairAllowed(symbol, req.user.subscription)) {
      return res.status(403).json({
        message: `Currency pair ${symbol} is not included in your ${getTierDisplayName(req.user.subscription?.tier)} plan.`,
        allowedCurrencyPairs: getAllowedCurrencyPairs(req.user.subscription)
      });
    }

    if (!isTimeframeAllowed(interval, req.user.subscription)) {
      return res.status(403).json({
        message: `Timeframe ${interval} is not included in your ${getTierDisplayName(req.user.subscription?.tier)} plan.`,
        allowedTimeframes: getTierFeatures(req.user.subscription).timeframes
      });
    }

    const hub = getMarketDataHub();
    const parsedLimit = parseInt(limit, 10) || 200;
    let payload = await hub.getCandles(symbol, interval, parsedLimit, { cacheOnly: true });
    if (!payload) {
      payload = await hub.getCandles(symbol, interval, parsedLimit, { allowProviderFetch: true });
    } else if (!hub.isFresh(payload, interval) && hub.canFetchFromProvider({ bypassGap: true })) {
      try {
        payload = await hub.getCandles(symbol, interval, parsedLimit, { allowProviderFetch: true });
      } catch (refreshError) {
        payload = {
          ...payload,
          stale: true,
          refreshError: toUserFacingMarketDataError(refreshError.message)
        };
      }
    }
    res.json(payload);
  } catch (error) {
    console.error('Market data proxy error:', error);
    res.status(502).json({
      message: toUserFacingMarketDataError(error.message, 'Unable to fetch market data')
    });
  }
});

app.get('/api/market-data/status', requireAuth, requireSubscription, async (req, res) => {
  try {
    const hub = getMarketDataHub();
    const redis = await require('./utils/redisClient').getRedisClient();
    res.json({
      status: 'ok',
      cacheBackend: redis ? 'redis' : 'memory',
      hub: hub.status(),
      providers: {
        primary: process.env.MARKET_DATA_PRIMARY || 'twelve_data',
        fallback: process.env.MARKET_DATA_FALLBACK || 'eodhd',
        twelve_data: Boolean(process.env.TWELVE_DATA_API_KEY),
        eodhd: Boolean(process.env.EODHD_API_KEY)
      },
      note: 'Twelve Data is used on-demand per viewed symbol+timeframe; one fetch broadcasts to all viewers.'
    });
  } catch (error) {
    console.error('Market data status error:', error);
    res.status(500).json({ message: 'Unable to load market data status', error: error.message });
  }
});

app.get('/api/performance/summary', requireAuth, requireSubscription, requireTierFeature('performanceDashboard'), async (req, res) => {
  try {
    const cutoff = historyCutoffDate(req.user.subscription);
    const signals = isDbReady()
      ? await Signal.find({
          createdAt: { $gte: cutoff },
          ...legacySourceMongoExclusion()
        })
          .sort({ createdAt: -1 })
          .limit(1000)
          .lean()
      : inMemorySignals.filter(s => !s.createdAt || new Date(s.createdAt) >= cutoff);

    const filtered = filterSignalsForTier(signals, req.user.subscription).filter(isWebhookInsightsSignal);
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

app.get('/api/system/status', requireAuth, async (req, res) => {
  try {
    const { createSystemStatusService } = require('./services/SystemStatusService');
    const Mt5TradeCopierService = require('./services/Mt5TradeCopierService');
    const statusService = createSystemStatusService({
      PythonAiService,
      TelegramService,
      Mt5TradeCopierService,
      MarketScannerService,
      getMarketDataHub,
      mongoose
    });
    const status = await statusService.getDistributionStatus(req.user || null);
    return res.json(status);
  } catch (error) {
    console.error('System status error:', error);
    return res.status(500).json({ message: 'Unable to load system status', error: safeErrorMessage(error) });
  }
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

app.get('/api/scanner/analyze', scannerLimiter, requireAuth, requireSubscription, async (req, res) => {
  try {
    const symbol = req.query.symbol;
    const interval = req.query.interval || '1h';

    if (!symbol) {
      return res.status(400).json({ message: 'symbol query parameter is required' });
    }

    if (!isCurrencyPairAllowed(symbol, req.user.subscription)) {
      return res.status(403).json({
        message: `Currency pair ${symbol} is not included in your plan.`,
        allowedCurrencyPairs: getAllowedCurrencyPairs(req.user.subscription)
      });
    }

    const result = await MarketScannerService.analyzeSymbol(symbol, interval);

    // Optional FastAPI AI analytics — Node supplies candles; Python never fetches providers.
    let pythonAi = null;
    if (PythonAiService.isConfigured()) {
      pythonAi = await PythonAiService.createSignal({
        symbol,
        interval,
        lookback: 100
      });
    }

    return res.json({ success: true, ...result, pythonAi });
  } catch (error) {
    console.error('Scanner analyze error:', error);
    return res.status(500).json({ message: 'Scanner analyze failed', error: error.message });
  }
});

/**
 * AI signal analytics via FastAPI.
 * Node resolves candles from MarketDataHub / ChartDataService and injects them into Python.
 */
app.post('/api/ai/signal', scannerLimiter, requireAuth, requireSubscription, async (req, res) => {
  try {
    if (!PythonAiService.isConfigured()) {
      return res.status(503).json({
        message: 'Python AI service is not configured (set PYTHON_SERVICE_URL).'
      });
    }

    const symbol = req.body?.symbol || req.query.symbol;
    const interval = req.body?.interval || req.query.interval || '1h';
    const lookback = Number(req.body?.lookback || 200);

    if (!symbol) {
      return res.status(400).json({ message: 'symbol is required' });
    }

    if (!isCurrencyPairAllowed(symbol, req.user.subscription)) {
      return res.status(403).json({
        message: `Currency pair ${symbol} is not included in your plan.`,
        allowedCurrencyPairs: getAllowedCurrencyPairs(req.user.subscription)
      });
    }

    const signal = await PythonAiService.createSignal(
      {
        symbol,
        interval,
        lookback,
        candles: req.body?.candles
      },
      { throwOnError: true }
    );

    return res.json({ success: true, signal });
  } catch (error) {
    console.error('AI signal error:', error);
    return res.status(502).json({
      message: 'AI signal analytics failed',
      error: safeErrorMessage(error)
    });
  }
});

app.post('/api/scanner/run', requireAuth, requireSubscription, requireTierFeature('multiMarketScanner'), async (req, res) => {
  try {
    // Architecture: do not generate or publish signals from live market data.
    // Premium multiMarketScanner = entitlement to receive TV webhook distribution across all pairs.
    return res.json({
      success: true,
      architecture: 'tradingview_webhook_distribution',
      published: false,
      feature: 'multi_market_distribution',
      message:
        'Premium multi-market distribution delivers TradingView webhook signals across all allowed pairs. Live market data is chart-only and does not publish trades.',
      results: await MarketScannerService.runFullScan(io)
    });
  } catch (error) {
    console.error('Scanner run error:', error);
    return res.status(500).json({ message: 'Scanner run failed', error: error.message });
  }
});

io.use(async (socket, next) => {
  try {
    const token = extractAuthTokenFromSocket(socket.handshake);
    if (!token) {
      return next(new Error('Authentication required'));
    }

    const payload = verifyToken(token);
    const user = await resolveUserById(payload.userId);

    if (!user) {
      return next(new Error('Invalid session'));
    }

    if (!userCanAccessLiveAlerts(user)) {
      return next(new Error('Active subscription required for live alerts'));
    }

    socket.user = withEffectiveAccess(user);
    socket.userId = user._id?.toString() || user.id;
    socket.join(`user:${socket.userId}`);
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

io.on('connection', socket => {
  socket.marketStreams = new Set();

  console.log('Subscriber connected:', socket.id, socket.userId);
  socket.emit('subscriber:ready', { userId: socket.userId });

  console.log('Client connected:', socket.id);

  socket.on('tv:subscribe', async ({ appUsername, tradingviewUsername }) => {
    try {
      if (!appUsername || !tradingviewUsername) {
        return;
      }

      const user = await resolveUser(appUsername);
      const userId = String(user?._id || user?.id || '');
      if (!user || userId !== String(socket.userId)) {
        socket.emit('tv:subscribe-error', { message: 'Unable to subscribe to live alerts for this account.' });
        return;
      }

      const normalizedTv = TradingViewAlertService.normalizeTradingViewUsername(tradingviewUsername);
      const linkedTv = TradingViewAlertService.normalizeTradingViewUsername(user?.tradingviewUsername);

      if (linkedTv !== normalizedTv || !userCanAccessTradingViewAlerts(user)) {
        socket.emit('tv:subscribe-error', { message: 'Unable to subscribe to live alerts for this TradingView username.' });
        return;
      }

      socket.join(`tv:${normalizedTv}`);
      socket.emit('tv:subscribed', { tradingviewUsername: normalizedTv, appUsername });
    } catch (error) {
      socket.emit('tv:subscribe-error', { message: 'Unable to subscribe to live alerts.' });
    }
  });

  socket.on('market:subscribe', async ({ symbol, interval: rawInterval = '1h', limit = 200 } = {}) => {
    try {
      if (!symbol) return;
      const interval = normalizeInterval(rawInterval);
      const features = getTierFeatures(socket.user.subscription);
      if (!isCurrencyPairAllowed(symbol, socket.user.subscription)) {
        socket.emit('market:error', { message: `Currency pair ${symbol} is not included in your plan.` });
        return;
      }
      if (!isTimeframeAllowed(interval, socket.user.subscription)) {
        socket.emit('market:error', {
          message: `Timeframe ${interval} is not included in your plan.`,
          allowedTimeframes: features.timeframes
        });
        return;
      }

      const hub = getMarketDataHub();
      const parsedLimit = parseInt(limit, 10) || 200;
      const { stream } = hub.watch(symbol, interval, parsedLimit);
      socket.marketStreams.add(hub.streamKey(symbol, interval));
      socket.join(hub.roomKey(symbol, interval));

      let payload = await hub.getCandles(symbol, interval, parsedLimit, { cacheOnly: true });

      if (payload) {
        socket.emit('market:candles', {
          ...payload,
          viewers: stream.viewers,
          stale: payload.stale || !hub.isFresh(payload, interval)
        });
      }

      const needsRefresh = !payload || !hub.isFresh(payload, interval);
      if (needsRefresh && hub.canFetchFromProvider({ bypassGap: true })) {
        try {
          payload = await hub.refreshStream(stream);
          socket.emit('market:candles', {
            ...payload,
            viewers: stream.viewers,
            stale: Boolean(payload.stale)
          });
        } catch (refreshError) {
          if (!payload) {
            throw refreshError;
          }
        }
        return;
      }

      if (payload) {
        return;
      }

      socket.emit('market:error', {
        message: hub.providerThrottleStatus().blockedUntil
          ? USER_FACING_MARKET_DATA_UNAVAILABLE
          : 'Unable to load chart data for this symbol.'
      });
    } catch (error) {
      console.error('[MarketData] subscribe error:', error.message);
      socket.emit('market:error', {
        message: toUserFacingMarketDataError(error.message, 'Unable to subscribe to market data')
      });
    }
  });

  socket.on('market:unsubscribe', ({ symbol, interval = '1h' } = {}) => {
    if (!symbol) return;
    const hub = getMarketDataHub();
    const streamKey = hub.streamKey(symbol, interval);
    hub.unwatch(symbol, interval);
    socket.marketStreams.delete(streamKey);
    socket.leave(hub.roomKey(symbol, interval));
  });

  socket.on('disconnect', () => {
    const hub = getMarketDataHub();
    for (const streamKey of socket.marketStreams || []) {
      const splitAt = streamKey.lastIndexOf(':');
      if (splitAt <= 0) continue;
      const symbol = streamKey.slice(0, splitAt);
      const interval = streamKey.slice(splitAt + 1);
      hub.unwatch(symbol, interval);
    }
    socket.marketStreams.clear();
    console.log('Client disconnected:', socket.id);
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({ message: safeErrorMessage(err, 'Internal server error.') });
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
  console.log(`Domain: ${APP_DOMAIN} | API: ${PUBLIC_BACKEND_URL} | Frontend: ${FRONTEND_URL}`);
  WeightLearningService.initWeightLearning().catch(err => {
    console.error('[WeightLearning] Boot init error (scanner continues):', err.message);
  });
  // Load persisted admin scanner/strategy/regime config before starting the scanner
  // so all traders share the same global runtime settings after restart.
  const bootScanner = () => {
    try {
      MarketScannerService.startAutoScanner(io);
    } catch (err) {
      console.error('[Scanner] startAutoScanner error:', err.message);
    }
  };
  try {
    const { initStrategyRuntimeConfig } = require('./utils/strategyRuntimeConfig');
    initStrategyRuntimeConfig()
      .then(() => bootScanner())
      .catch(err => {
        console.error('[StrategyRuntime] Boot init error (env defaults kept):', err.message);
        bootScanner();
      });
  } catch (err) {
    console.error('[StrategyRuntime] Module load error:', err.message);
    bootScanner();
  }
  if (TelegramService.isConfigured()) {
    TelegramService.ensureDeliveryMode().catch(err => {
      console.error('[Telegram] Delivery mode setup failed:', err.message);
    });
  }
  // Hourly: revoke access when subscription.current_period_end (expiryDate) has passed.
  try {
    ActivationService.startExpiryJob(io);
  } catch (err) {
    console.error('[Activation] Failed to start expiry job:', err.message);
  }
});
