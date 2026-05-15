const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const dotenv = require('dotenv');

dotenv.config();

const Signal = require('./models/Signal');
const UserConfig = require('./models/User');

const TRADINGVIEW_WEBHOOK_SECRET = process.env.TRADINGVIEW_WEBHOOK_SECRET || '';

function verifyTradingViewSecret(req) {
  const headerSecret = req.headers['x-tradingview-secret'];
  const bodySecret = req.body.secret;
  return TRADINGVIEW_WEBHOOK_SECRET && (headerSecret === TRADINGVIEW_WEBHOOK_SECRET || bodySecret === TRADINGVIEW_WEBHOOK_SECRET);
}

function parseTradingViewPayload(body) {
  const symbol = body.symbol || body.ticker || body.instrument || body.market || body.data?.symbol || 'UNKNOWN';
  const direction = (body.direction || body.action || body.signal || body.trade || 'neutral').toString().toLowerCase();
  const entry = parseFloat(body.entry || body.price || body.data?.entry || body.data?.price || 0) || 0;
  const stop_loss = parseFloat(body.stop_loss || body.sl || body.stoploss || body.data?.stop_loss || 0) || 0;
  const take_profit_1 = parseFloat(body.take_profit_1 || body.tp1 || body.tp_1 || body.data?.take_profit_1 || 0) || 0;
  const take_profit_2 = parseFloat(body.take_profit_2 || body.tp2 || body.tp_2 || body.data?.take_profit_2 || 0) || 0;
  const take_profit_3 = parseFloat(body.take_profit_3 || body.tp3 || body.tp_3 || body.data?.take_profit_3 || 0) || 0;
  const confidence = parseFloat(body.confidence || body.confidence_score || body.data?.confidence || 0) || 0;
  const notes = body.message || body.note || body.notes || JSON.stringify(body);
  const tradingviewUsername = body.tradingviewUsername || body.username || body.user || body.trader || '';

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
    take_profit_1: safeTp1,
    take_profit_2: safeTp2,
    take_profit_3: safeTp3,
    confidence: Math.min(Math.max(confidence, 0), 1),
    notes,
    tradingviewUsername
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
app.use(express.json());

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

    const signalData = parseTradingViewPayload(req.body);
    if (!signalData.symbol || !signalData.direction) {
      return res.status(400).json({ message: 'Invalid TradingView payload' });
    }

    const signal = new Signal(signalData);
    const saved = await signal.save();

    if (signalData.tradingviewUsername) {
      await UserConfig.findOneAndUpdate(
        { tradingviewUsername: signalData.tradingviewUsername },
        { tradingviewUsername: signalData.tradingviewUsername },
        { upsert: true, new: true }
      );
    }

    io.emit('signal:update', saved);
    return res.status(201).json({ success: true, signal: saved });
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

io.on('connection', socket => {
  console.log('Client connected:', socket.id);
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
});
