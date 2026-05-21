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
const { TIERS, TRIAL_DAYS, PAYMENT_CONFIG } = require('./config/subscriptions');
const TradingViewService = require('./services/TradingViewService');
const TradingViewAlertService = require('./services/TradingViewAlertService');
const MarketScannerService = require('./services/MarketScannerService');
const requireTradingViewAccess = require('./middleware/requireTradingViewAccess');
const { canAccessTradingViewAlerts } = require('./utils/subscriptionAccess');
<<<<<<< HEAD
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
=======
>>>>>>> 2e905453a44bc6c7244c4118a1ccb223eb8d5058

const TRADINGVIEW_WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || '';
const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;

function verifyTradingViewSecret(req) {
  const headerSecret = req.headers['x-tradingview-secret'];
  const bodySecret = req.body.secret;
  return TRADINGVIEW_WEBHOOK_SECRET && (headerSecret === TRADINGVIEW_WEBHOOK_SECRET || bodySecret === TRADINGVIEW_WEBHOOK_SECRET);
}

function parseTradingViewPayload(body) {
  const parsed = TradingViewAlertService.parseWebhookBody(body);
  const symbol = parsed.symbol || parsed.ticker || parsed.instrument || parsed.market || parsed.data?.symbol || 'UNKNOWN';
  const direction = (parsed.direction || parsed.action || parsed.signal || parsed.trade || 'neutral').toString().toLowerCase();
  const entry = parseFloat(parsed.entry || parsed.price || parsed.data?.entry || parsed.data?.price || 0) || 0;
  const stop_loss = parseFloat(parsed.stop_loss || parsed.stop_loss_1 || parsed.sl || parsed.stoploss || parsed.data?.stop_loss || 0) || 0;
  const stop_loss_1 = parseFloat(parsed.stop_loss_1 || parsed.stop_loss || parsed.sl || 0) || 0;
  const stop_loss_2 = parseFloat(parsed.stop_loss_2 || 0) || 0;
  const stop_loss_3 = parseFloat(parsed.stop_loss_3 || 0) || 0;
  const take_profit_1 = parseFloat(parsed.take_profit_1 || parsed.tp1 || parsed.tp_1 || parsed.data?.take_profit_1 || 0) || 0;
  const take_profit_2 = parseFloat(parsed.take_profit_2 || parsed.tp2 || parsed.tp_2 || parsed.data?.take_profit_2 || 0) || 0;
  const take_profit_3 = parseFloat(parsed.take_profit_3 || parsed.tp3 || parsed.tp_3 || parsed.data?.take_profit_3 || 0) || 0;
  const confidence = parseFloat(parsed.confidence || parsed.confidence_score || parsed.data?.confidence || 0) || 0;
  const notes = parsed.message || parsed.note || parsed.notes || JSON.stringify(parsed);
  const tradingviewUsername = TradingViewAlertService.normalizeTradingViewUsername(
    parsed.tradingviewUsername || parsed.username || parsed.user || parsed.trader || ''
  );

  const safeEntry = entry || 0;
  const safeStop = stop_loss || (safeEntry ? safeEntry * 0.995 : 0);
  const safeTp1 = take_profit_1 || (safeEntry ? (direction === 'short' ? safeEntry * 0.99 : safeEntry * 1.01) : 0);
  const safeTp2 = take_profit_2 || (safeEntry ? (direction === 'short' ? safeEntry * 0.98 : safeEntry * 1.02) : 0);
  const safeTp3 = take_profit_3 || (safeEntry ? (direction === 'short' ? safeEntry * 0.965 : safeEntry * 1.035) : 0);

  return {
    symbol,
    direction,
    entry: safeEntry,
    stop_loss: safeStop,
    stop_loss_1: stop_loss_1 || safeStop,
    stop_loss_2: stop_loss_2 || undefined,
    stop_loss_3: stop_loss_3 || undefined,
    take_profit_1: safeTp1,
    take_profit_2: safeTp2,
    take_profit_3: safeTp3,
    confidence: Math.min(Math.max(confidence, 0), 1),
    notes,
    tradingviewUsername,
    alertType: TradingViewAlertService.normalizeAlertType(parsed.alertType || parsed.alert_type || parsed.type)
  };
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
  const dbState = mongoose.connection.readyState; // 0 = disconnected, 1 = connected
  res.json({ status: 'ok', service: 'backend', dbState });
});

const inMemorySignals = [];

app.post('/api/signals', async (req, res) => {
  try {
    const payload = req.body;

    if (mongoose.connection.readyState !== 1) {
      // Fallback: store in memory when DB is unavailable
      const fallback = Object.assign({}, payload, { createdAt: new Date() });
      inMemorySignals.unshift(fallback);
      io.emit('signal:update', fallback);
      return res.status(201).json({ fallback: true, signal: fallback });
    }

    const signal = new Signal(payload);
    const saved = await signal.save();

    io.emit('signal:update', saved);

    if (payload.broadcast === true || payload.broadcast === 'true' || !payload.tradingviewUsername) {
      await TradingViewAlertService.broadcastToSubscribers(io, {
        ...payload,
        source: payload.source || 'scanner',
        alertType: TradingViewAlertService.normalizeAlertType(payload.alertType || 'signal')
      });
    } else if (payload.tradingviewUsername) {
      await TradingViewAlertService.deliverToTradingViewUser(
        io,
        payload.tradingviewUsername,
        {
          ...payload,
          source: payload.source || 'scanner',
          alertType: TradingViewAlertService.normalizeAlertType(payload.alertType || 'signal')
        }
      );
    }

    return res.status(201).json(saved);
  } catch (error) {
    console.error('Error saving signal:', error);
    // Last-resort fallback
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
    if (result.mode === 'direct' && !result.delivered) {
      return res.status(404).json({
        message: 'No active subscriber found for that TradingView username.',
        tradingviewUsername: TradingViewAlertService.normalizeTradingViewUsername(
          TradingViewAlertService.parseWebhookBody(req.body).tradingviewUsername
        )
      });
    }

    return res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error('TradingView webhook error:', error);
    return res.status(500).json({ message: 'TradingView webhook processing failed', error: error.message });
  }
});

app.get('/api/signals', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json(inMemorySignals.slice(0, 100));
    }
    const signals = await Signal.find().sort({ createdAt: -1 }).limit(100);
    // prepend any in-memory signals that occurred while DB was down
    if (inMemorySignals.length) {
      return res.json(inMemorySignals.concat(signals));
    }
    res.json(signals);
  } catch (error) {
    console.error('Error fetching signals:', error);
    return res.status(500).json({ message: 'Unable to fetch signals', error: String(error) });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const { username, tradingviewUsername, preferences } = req.body;
    const user = await UserConfig.findOneAndUpdate(
      { username },
      { tradingviewUsername, preferences },
      { upsert: true, new: true }
    );
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Unable to save user config' });
  }
});

app.post('/api/users/link', async (req, res) => {
  try {
    const { username, tradingviewUsername } = req.body;
    if (!username || !tradingviewUsername) {
      return res.status(400).json({ message: 'Both username and tradingviewUsername are required.' });
    }

    const user = await UserConfig.findOneAndUpdate(
      { username },
      { tradingviewUsername },
      { upsert: true, new: true }
    );

    res.json({ success: true, user });
  } catch (error) {
    console.error('User link error:', error);
    res.status(500).json({ message: 'Unable to link tradingview username' });
  }
});

// ===== SUBSCRIPTION ENDPOINTS =====

app.get('/api/tiers', (req, res) => {
  res.json(TIERS);
});

app.post('/api/subscribe', async (req, res) => {
  try {
    const { username, email, phone, tier, provider } = req.body;

    if (!username || !tier || !provider) {
      return res.status(400).json({ message: 'username, tier, and provider are required' });
    }

    if (!TIERS[tier]) {
      return res.status(400).json({ message: 'Invalid tier' });
    }

    if (!['mpesa', 'paypal', 'mock'].includes(provider)) {
      return res.status(400).json({ message: 'Invalid provider' });
    }

    // Upsert user
    let user = await UserConfig.findOneAndUpdate(
      { username },
      { email, phone },
      { upsert: true, new: true }
    );

    // In mock mode, we simulate payment initiation
    if (provider === 'mock') {
      const mockPaymentId = `mock_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      user = await UserConfig.findOneAndUpdate(
        { username },
        {
          subscription: {
            tier,
            status: 'pending',
            provider: 'mock',
            providerOrderId: mockPaymentId,
            trialEnds: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
          }
        },
        { new: true }
      );

      return res.json({
        success: true,
        message: 'Mock payment initiated',
        user,
        mockPaymentId,
        confirmUrl: `/api/payments/mock/confirm?username=${username}&paymentId=${mockPaymentId}&tier=${tier}`
      });
    }

    // M-Pesa STK Push flow
    if (provider === 'mpesa') {
      if (!phone) {
        return res.status(400).json({ message: 'Phone number required for M-Pesa' });
      }

      // In production: initiate STK push via Daraja APIs
      // For now: return pending state
      const stkRequestId = `stk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      user = await UserConfig.findOneAndUpdate(
        { username },
        {
          subscription: {
            tier,
            status: 'pending',
            provider: 'mpesa',
            providerOrderId: stkRequestId
          }
        },
        { new: true }
      );

      return res.json({
        success: true,
        message: 'M-Pesa STK push initiated. Check your phone for the prompt.',
        user,
        stkRequestId,
        amount: TIERS[tier].price
      });
    }

    // PayPal checkout flow
    if (provider === 'paypal') {
      // In production: create PayPal order/subscription
      // For now: return checkout URL (stub)
      const checkoutId = `paypal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      user = await UserConfig.findOneAndUpdate(
        { username },
        {
          subscription: {
            tier,
            status: 'pending',
            provider: 'paypal',
            providerOrderId: checkoutId
          }
        },
        { new: true }
      );

      return res.json({
        success: true,
        message: 'PayPal checkout session created',
        user,
        checkoutId,
        checkoutUrl: `https://sandbox.paypal.com/checkoutnow?token=${checkoutId}` // stub
      });
    }
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ message: 'Unable to initiate subscription', error: error.message });
  }
});

app.get('/api/subscription/:username', async (req, res) => {
  try {
    const { username } = req.params;
<<<<<<< HEAD
    const user = await resolveUser(username);
=======
    const user = await UserConfig.findOne({ username });
>>>>>>> 2e905453a44bc6c7244c4118a1ccb223eb8d5058

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

// Mock payment confirmation endpoint (for development/testing)
app.post('/api/payments/mock/confirm', async (req, res) => {
  try {
    const { username, paymentId, tier } = req.body;

    if (!username || !paymentId || !tier) {
      return res.status(400).json({ message: 'username, paymentId, and tier are required' });
    }

    const user = await UserConfig.findOneAndUpdate(
      { username },
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

    io.emit('subscription:updated', { username, subscription: user.subscription });

    res.json({
      success: true,
      message: 'Mock payment confirmed. Subscription activated!',
      user
    });
  } catch (error) {
    console.error('Mock payment confirm error:', error);
    res.status(500).json({ message: 'Unable to confirm mock payment', error: error.message });
  }
});

// M-Pesa callback webhook (Daraja notification)
app.post('/api/webhook/mpesa', async (req, res) => {
  try {
    // Webhook payload from Daraja (M-Pesa)
    // Extract payment details and verify
    const body = req.body;

    console.log('M-Pesa webhook received:', body);

    // In production: verify signature and parse callback data
    // For now: acknowledge receipt
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
  } catch (error) {
    console.error('M-Pesa webhook error:', error);
    res.status(200).json({ ResultCode: 1, ResultDesc: 'Error' });
  }
});

// PayPal webhook
app.post('/api/webhook/paypal', async (req, res) => {
  try {
    const body = req.body;

    console.log('PayPal webhook received:', body);

    // In production: verify webhook signature
    // if (!verifyPayPalSignature(req)) return res.status(401).json({ error: 'Invalid signature' });

    // Handle specific event types
    // const event = body.event_type;

    res.status(200).json({ status: 'received' });
  } catch (error) {
    console.error('PayPal webhook error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Payment webhook (generic)
app.post('/api/webhook/payments', async (req, res) => {
  try {
    const { event, provider, username, tier, status } = req.body;

    if (!username || !provider) {
      return res.status(400).json({ message: 'username and provider are required' });
    }

    if (status === 'success' || event === 'payment.completed') {
      const user = await UserConfig.findOneAndUpdate(
        { username },
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

      io.emit('subscription:updated', { username, subscription: user.subscription });

      return res.json({ success: true, message: 'Subscription activated', user });
    }

    if (status === 'cancelled' || event === 'payment.cancelled') {
      const user = await UserConfig.findOneAndUpdate(
        { username },
        { 'subscription.status': 'cancelled' },
        { new: true }
      );

      io.emit('subscription:updated', { username, subscription: user.subscription });

      return res.json({ success: true, message: 'Subscription cancelled', user });
    }

    res.json({ message: 'Event processed' });
  } catch (error) {
    console.error('Payment webhook error:', error);
    res.status(500).json({ message: 'Webhook processing error', error: error.message });
  }
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
<<<<<<< HEAD
    const user = await resolveUser(username);
=======
    const user = await UserConfig.findOne({ username });
>>>>>>> 2e905453a44bc6c7244c4118a1ccb223eb8d5058

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

// Get historical data for a symbol from TradingView
app.get('/api/tradingview/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { interval = '1h', limit = 100 } = req.query;

    const historicalData = await TradingViewService.getHistoricalData(symbol, interval, parseInt(limit));
    const indicators = TradingViewService.calculateIndicators(historicalData);

    res.json({
      symbol,
      interval,
      data: historicalData,
      indicators
    });
  } catch (error) {
    console.error('Get historical data error:', error);
    res.status(500).json({ message: 'Unable to fetch historical data', error: error.message });
  }
});

// Pine Script for subscribers (includes webhook URL + username placeholders)
app.get('/api/tradingview/pine-script', (req, res) => {
  try {
    const { tradingviewUsername } = req.query;
    const pinePath = path.join(__dirname, 'tradingview-bot.pine');
    let script = fs.readFileSync(pinePath, 'utf8');
    const webhookUrl = `${PUBLIC_BACKEND_URL}/api/webhook/tradingview`;
    const secret = TRADINGVIEW_WEBHOOK_SECRET || 'your_webhook_secret';

    script = script
      .replace('http://localhost:4000/api/webhook/tradingview', webhookUrl)
      .replace('your_webhook_secret', secret)
      .replace('your_tradingview_username', tradingviewUsername || 'your_tradingview_username');

    res.json({
      script,
      webhookUrl,
      tradingviewUsername: tradingviewUsername || null,
      instructions: [
        'Add this script to your TradingView chart.',
        'Set your TradingView username in the script inputs.',
        'Create an alert with "Webhook URL" and use the message from the script.',
        'Link the same username in the KachingFx app under TradingView.'
      ]
    });
  } catch (error) {
    console.error('Pine script error:', error);
    res.status(500).json({ message: 'Unable to load Pine Script', error: error.message });
  }
});

// Get alerts for a specific symbol (organized by TradingView username)
app.get('/api/tradingview/alerts/:tradingviewUsername/:symbol', async (req, res) => {
  try {
    const { tradingviewUsername, symbol } = req.params;
    const { username } = req.query;
    const requester = username ? await UserConfig.findOne({ username }) : null;

    if (username && (!requester || !canAccessTradingViewAlerts(requester.subscription))) {
      return res.status(403).json({ message: 'Active subscription required to view live alerts.' });
    }

    const normalizedTv = TradingViewAlertService.normalizeTradingViewUsername(tradingviewUsername);
    const signals = await Signal.find({
      tradingviewUsername: { $regex: new RegExp(`^${normalizedTv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      symbol
    }).sort({ createdAt: -1 }).limit(50);

    res.json({
      tradingviewUsername: normalizedTv,
      symbol,
      alerts: signals,
      count: signals.length
    });
  } catch (error) {
    console.error('Get alerts error:', error);
    res.status(500).json({ message: 'Unable to fetch alerts', error: error.message });
  }
});

// Get all alerts for a TradingView user (across all symbols)
app.get('/api/tradingview/alerts/:tradingviewUsername', async (req, res) => {
  try {
    const { tradingviewUsername } = req.params;
    const { username } = req.query;
    const requester = username ? await UserConfig.findOne({ username }) : null;

    if (username && (!requester || !canAccessTradingViewAlerts(requester.subscription))) {
      return res.status(403).json({ message: 'Active subscription required to view live alerts.' });
    }

    const normalizedTv = TradingViewAlertService.normalizeTradingViewUsername(tradingviewUsername);
    const signals = await Signal.find({
      tradingviewUsername: { $regex: new RegExp(`^${normalizedTv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    }).sort({ createdAt: -1 }).limit(200);

    // Group by symbol
    const bySymbol = signals.reduce((acc, signal) => {
      if (!acc[signal.symbol]) acc[signal.symbol] = [];
      acc[signal.symbol].push(signal);
      return acc;
    }, {});

    res.json({
      tradingviewUsername,
      totalAlerts: signals.length,
      symbols: Object.keys(bySymbol),
      alertsBySymbol: bySymbol
    });
  } catch (error) {
    console.error('Get all alerts error:', error);
    res.status(500).json({ message: 'Unable to fetch alerts', error: error.message });
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
      symbol,
      open,
      high,
      low,
      close,
      volume,
      time
    });

    return res.status(201).json({ success: true, scanResult });
  } catch (error) {
    console.error('Scanner candle error:', error);
    return res.status(500).json({ message: 'Scanner candle processing failed', error: error.message });
  }
});

app.post('/api/scanner/run', async (req, res) => {
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

// Send alert back to TradingView (webhook notification)
app.post('/api/tradingview/send-alert', async (req, res) => {
  try {
    const { username, symbol, message, direction, confidence } = req.body;

    const user = await UserConfig.findOne({ username });
    if (!user || !user.tradingview?.userId) {
      return res.status(404).json({ message: 'TradingView account not linked' });
    }

    const alertResponse = await TradingViewService.sendAlertToTradingView(
      user.tradingview.userId,
      symbol,
      message
    );

    io.emit('tradingview:alert-sent', { username, symbol, message, direction, confidence });

    res.json({ success: true, alert: alertResponse });
  } catch (error) {
    console.error('Send alert error:', error);
    res.status(500).json({ message: 'Unable to send alert', error: error.message });
  }
});

io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  socket.on('tv:subscribe', async ({ appUsername, tradingviewUsername }) => {
    try {
      if (!appUsername || !tradingviewUsername) {
        return;
      }

<<<<<<< HEAD
      const user = await resolveUser(appUsername);
=======
      const user = await UserConfig.findOne({ username: appUsername });
>>>>>>> 2e905453a44bc6c7244c4118a1ccb223eb8d5058
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
});
