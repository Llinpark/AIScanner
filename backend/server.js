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
const { TIERS, TRIAL_DAYS } = require('./config/subscriptions');
const TradingViewService = require('./services/TradingViewService');
const TradingViewAlertService = require('./services/TradingViewAlertService');
const MarketScannerService = require('./services/MarketScannerService');
const authRoutes = require('./routes/auth');
const requireAuth = require('./middleware/requireAuth');
const requireSubscription = require('./middleware/requireSubscription');
const validateRequest = require('./middleware/validate');
const { subscribeValidators } = require('./validators/authValidators');
const { canAccessLiveAlerts } = require('./utils/subscriptionAccess');
const { verifyToken, sanitizeUser } = require('./utils/auth');
const { resolveUserById } = require('./middleware/requireAuth');

const TRADINGVIEW_WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || '';
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function verifyTradingViewSecret(req) {
  const headerSecret = req.headers['x-tradingview-secret'];
  const bodySecret = req.body.secret;
  return TRADINGVIEW_WEBHOOK_SECRET && (headerSecret === TRADINGVIEW_WEBHOOK_SECRET || bodySecret === TRADINGVIEW_WEBHOOK_SECRET);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/*', 'application/x-www-form-urlencoded'] }));

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

app.post('/api/signals', async (req, res) => {
  try {
    const payload = req.body;

    if (!isDbReady()) {
      const fallback = Object.assign({}, payload, { createdAt: new Date() });
      inMemorySignals.unshift(fallback);
      io.emit('signal:update', fallback);
      return res.status(201).json({ fallback: true, signal: fallback });
    }

    const signal = new Signal(payload);
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

app.post('/api/webhook/tradingview', async (req, res) => {
  try {
    if (!verifyTradingViewSecret(req)) {
      return res.status(401).json({ message: 'Invalid webhook secret' });
    }

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

    const result = await TradingViewAlertService.processIncomingWebhook(io, req.body);
    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error('TradingView webhook error:', error);
    return res.status(500).json({ message: 'TradingView webhook processing failed', error: error.message });
  }
});

app.get('/api/signals', requireAuth, requireSubscription, async (req, res) => {
  try {
    if (!isDbReady()) {
      return res.json(inMemorySignals.slice(0, 100));
    }
    const signals = await Signal.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(100);
    if (inMemorySignals.length) {
      return res.json(inMemorySignals.concat(signals));
    }
    res.json(signals);
  } catch (error) {
    console.error('Error fetching signals:', error);
    return res.status(500).json({ message: 'Unable to fetch signals', error: String(error) });
  }
});

// ===== SUBSCRIPTION ENDPOINTS =====

app.get('/api/tiers', (req, res) => {
  res.json(TIERS);
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
            providerOrderId: mockPaymentId,
            trialEnds: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
          },
          updatedAt: new Date()
        },
        { new: true }
      );

      return res.json({
        success: true,
        message: 'Mock payment initiated',
        user: sanitizeUser(user),
        mockPaymentId
      });
    }

    if (provider === 'mpesa') {
      const stkRequestId = `stk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      user = await UserConfig.findByIdAndUpdate(
        userId,
        {
          phone,
          subscription: {
            tier,
            status: 'pending',
            provider: 'mpesa',
            providerOrderId: stkRequestId
          },
          updatedAt: new Date()
        },
        { new: true }
      );

      return res.json({
        success: true,
        message: 'M-Pesa STK push initiated. Check your phone for the prompt.',
        user: sanitizeUser(user),
        stkRequestId,
        amount: TIERS[tier].price
      });
    }

    if (provider === 'paypal') {
      const checkoutId = `paypal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      user = await UserConfig.findByIdAndUpdate(
        userId,
        {
          subscription: {
            tier,
            status: 'pending',
            provider: 'paypal',
            providerOrderId: checkoutId
          },
          updatedAt: new Date()
        },
        { new: true }
      );

      return res.json({
        success: true,
        message: 'PayPal checkout session created',
        user: sanitizeUser(user),
        checkoutId,
        checkoutUrl: `https://sandbox.paypal.com/checkoutnow?token=${checkoutId}`
      });
    }
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ message: 'Unable to initiate subscription', error: error.message });
  }
});

app.get('/api/subscription/me', requireAuth, (req, res) => {
  res.json({
    user: sanitizeUser(req.user)
  });
});

app.post('/api/payments/mock/confirm', requireAuth, async (req, res) => {
  try {
    const { paymentId, tier } = req.body;

    if (!paymentId || !tier) {
      return res.status(400).json({ message: 'paymentId and tier are required' });
    }

    const user = await UserConfig.findByIdAndUpdate(
      req.userId,
      {
        subscription: {
          tier,
          status: 'active',
          provider: 'mock',
          providerOrderId: paymentId,
          current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          updatedAt: new Date()
        }
      },
      { new: true }
    );

    io.emit('subscription:updated', { userId: req.userId, subscription: user.subscription });

    res.json({
      success: true,
      message: 'Subscription activated! Open TradingView for live Entry, SL, and TP alerts.',
      user: sanitizeUser(user)
    });
  } catch (error) {
    console.error('Mock payment confirm error:', error);
    res.status(500).json({ message: 'Unable to confirm mock payment', error: error.message });
  }
});

app.post('/api/webhook/mpesa', async (req, res) => {
  try {
    console.log('M-Pesa webhook received:', req.body);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
  } catch (error) {
    console.error('M-Pesa webhook error:', error);
    res.status(200).json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

app.post('/api/webhook/paypal', async (req, res) => {
  try {
    console.log('PayPal webhook received:', req.body);
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
      'Create alerts for Entry, Stop Loss, Take Profit 1, Take Profit 2, and Take Profit 3.',
      'Enable TradingView push/email notifications so alerts reach you in real time.',
      'Live signals from KachingFx are also delivered to this dashboard while your subscription is active.'
    ]
  });
});

app.get('/api/tradingview/pine-script', requireAuth, requireSubscription, (req, res) => {
  try {
    const pinePath = path.join(__dirname, 'tradingview-bot.pine');
    let script = fs.readFileSync(pinePath, 'utf8');
    const webhookUrl = `${PUBLIC_BACKEND_URL}/api/webhook/tradingview`;
    const secret = TRADINGVIEW_WEBHOOK_SECRET || 'your_webhook_secret';

    script = script
      .replace('http://localhost:4000/api/webhook/tradingview', webhookUrl)
      .replace('your_webhook_secret', secret);

    res.json({
      script,
      webhookUrl,
      instructions: [
        'Open TradingView → Pine Editor → paste this script and add it to your chart.',
        'Create an alert on the chart for each level: Entry, Stop Loss, TP1, TP2, and TP3.',
        'Use TradingView notification settings (app push, email, or webhook) for real-time delivery.',
        'Your KachingFx subscription unlocks the live alert feed in this dashboard — no TradingView username linking required.'
      ]
    });
  } catch (error) {
    console.error('Pine script error:', error);
    res.status(500).json({ message: 'Unable to load Pine Script', error: error.message });
  }
});

app.get('/api/tradingview/alerts', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { symbol } = req.query;
    const filter = { userId: req.userId };
    if (symbol) filter.symbol = symbol;

    const signals = await Signal.find(filter).sort({ createdAt: -1 }).limit(symbol ? 50 : 200);

    res.json({
      symbol: symbol || null,
      alerts: signals,
      count: signals.length
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

    const historicalData = await TradingViewService.getHistoricalData(symbol, interval, parseInt(limit, 10));
    const indicators = TradingViewService.calculateIndicators(historicalData);

    res.json({ symbol, interval, data: historicalData, indicators });
  } catch (error) {
    console.error('Get historical data error:', error);
    res.status(500).json({ message: 'Unable to fetch historical data', error: error.message });
  }
});

// ===== STRUCTURAL PATTERN SCANNER =====

app.get('/api/scanner/status', (req, res) => {
  res.json(MarketScannerService.getScannerStatus());
});

app.get('/api/scanner/patterns', (req, res) => {
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
    config: require('./config/patternScanner').PATTERN_SCANNER_CONFIG
  });
});

app.post('/api/scanner/candle', async (req, res) => {
  try {
    if (!verifyTradingViewSecret(req)) {
      return res.status(401).json({ message: 'Invalid webhook secret' });
    }

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

app.post('/api/scanner/run', requireAuth, requireSubscription, async (req, res) => {
  try {
    const { symbol } = req.body;
    const results = symbol
      ? [await MarketScannerService.scanSymbol(io, symbol)]
      : await MarketScannerService.runFullScan(io);
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
});
