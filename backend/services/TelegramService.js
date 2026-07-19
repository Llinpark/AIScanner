const crypto = require('crypto');
const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const devUserStore = require('../utils/devUserStore');
const { hasTierFeature, getTierDisplayName } = require('../utils/subscriptionAccess');
const { formatKachingAlertMessage } = require('../utils/kachingSignalLevels');
const { isEntryAlert } = require('../utils/signalOutcome');
const Mt5TradeCopierService = require('./Mt5TradeCopierService');

const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const linkCodeIndex = new Map();
let pollingActive = false;
let pollingOffset = 0;

function getConfig() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    botUsername: (process.env.TELEGRAM_BOT_USERNAME || 'KachingFx_Official').replace(/^@/, ''),
    usePolling: process.env.TELEGRAM_USE_POLLING === 'true',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || ''
  };
}

function isConfigured() {
  return Boolean(getConfig().botToken);
}

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

async function persistUserTelegram(userId, telegram) {
  if (isDbConnected()) {
    return UserConfig.findByIdAndUpdate(
      userId,
      { telegram, updatedAt: new Date() },
      { new: true }
    );
  }

  return devUserStore.upsertUser(userId, { telegram });
}

async function findUserById(userId) {
  if (isDbConnected()) {
    return UserConfig.findById(userId);
  }
  return devUserStore.findById(userId);
}

function storeLinkCode(code, userId, expiresAt) {
  linkCodeIndex.set(code, { userId, expiresAt });
}

function consumeLinkCode(code) {
  const entry = linkCodeIndex.get(code);
  if (!entry) return null;
  if (entry.expiresAt < new Date()) {
    linkCodeIndex.delete(code);
    return null;
  }
  linkCodeIndex.delete(code);
  return entry.userId;
}

async function createLinkCode(userId) {
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);

  storeLinkCode(code, userId, expiresAt);

  const current = await getTelegramState(userId);
  await persistUserTelegram(userId, {
    ...current,
    linkCode: code,
    linkCodeExpiresAt: expiresAt,
    enabled: current.enabled !== false
  });

  return { code, expiresAt, botUsername: getConfig().botUsername };
}

async function getTelegramState(userId) {
  const user = await findUserById(userId);
  return user?.telegram || {};
}

function getBotDeepLink(startPayload = '') {
  const username = getConfig().botUsername;
  if (!username) return null;
  return startPayload
    ? `https://t.me/${username}?start=${encodeURIComponent(startPayload)}`
    : `https://t.me/${username}`;
}

async function apiRequest(method, payload = {}) {
  const { botToken } = getConfig();
  if (!botToken) {
    throw new Error('Telegram bot token is not configured');
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram API error (${method})`);
  }

  return data.result;
}

async function sendMessage(chatId, text, options = {}) {
  if (!chatId || !isConfigured()) return null;

  try {
    const payload = {
      chat_id: chatId,
      text,
      parse_mode: options.parseMode || 'HTML',
      disable_web_page_preview: true
    };

    if (options.replyMarkup) {
      payload.reply_markup = options.replyMarkup;
    }

    return await apiRequest('sendMessage', payload);
  } catch (error) {
    console.warn('[Telegram] sendMessage failed:', error.message);
    return null;
  }
}

async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
  if (!callbackQueryId || !isConfigured()) return null;

  try {
    return await apiRequest('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text || '',
      show_alert: showAlert
    });
  } catch (error) {
    console.warn('[Telegram] answerCallbackQuery failed:', error.message);
    return null;
  }
}

async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  if (!chatId || !messageId || !isConfigured()) return null;

  try {
    return await apiRequest('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup
    });
  } catch (error) {
    console.warn('[Telegram] editMessageReplyMarkup failed:', error.message);
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatSignalMessage(signal, subscriber = null) {
  const alertType = signal.alertType || 'signal';
  const title = escapeHtml(formatKachingAlertMessage(signal).split('|')[0]?.trim() || 'Kaching Alert');
  const sl = signal.stop_loss_1 ?? signal.stop_loss;
  const lines = [
    `<b>${title}</b>`,
    `<b>Symbol:</b> ${escapeHtml(signal.symbol)}`,
    `<b>Direction:</b> ${escapeHtml(String(signal.direction || '').toUpperCase())}`,
    `<b>Kaching Entry:</b> ${Number(signal.entry).toFixed(5)}`,
    `<b>Kaching SL:</b> ${Number(sl).toFixed(5)}`,
    `<b>Kaching TP1:</b> ${Number(signal.take_profit_1).toFixed(5)}`,
    `<b>Kaching TP2:</b> ${Number(signal.take_profit_2).toFixed(5)}`,
    `<b>Kaching TP3:</b> ${Number(signal.take_profit_3).toFixed(5)}`
  ];

  if (subscriber && hasTierFeature(subscriber.subscription, 'autoLotSizing')) {
    const lotSize = Mt5TradeCopierService.computeLotSize(signal, subscriber);
    if (lotSize) {
      lines.push(`<b>Auto Lot Size:</b> ${Number(lotSize).toFixed(2)}`);
    }
  }

  if (signal.confidence != null) {
    lines.push(`<b>Confidence:</b> ${Math.round(Number(signal.confidence) * 100)}%`);
  }

  if (signal.tradeExplanation) {
    lines.push(`\n<i>${escapeHtml(signal.tradeExplanation)}</i>`);
  }

  if (isEntryAlert(alertType) && subscriber && hasTierFeature(subscriber.subscription, 'mt5Execution')) {
    lines.push('\n<i>Tap Execute to copy this trade to MT5 — entry, SL, TP, and lot size are filled automatically.</i>');
  }

  return lines.filter(Boolean).join('\n');
}

function buildExecuteCallbackData(signalId) {
  return `exec:${String(signalId)}`.slice(0, 64);
}

function parseExecuteCallbackData(data) {
  const raw = String(data || '');
  if (!raw.startsWith('exec:')) return null;
  return raw.slice(5);
}

function buildSignalReplyMarkup(signal, subscriber) {
  if (!subscriber || !hasTierFeature(subscriber.subscription, 'mt5Execution')) {
    return null;
  }

  if (!isEntryAlert(signal.alertType || 'signal')) {
    return null;
  }

  const mt5 = subscriber.mt5 || {};
  if (!mt5.linkToken || mt5.enabled === false) {
    return null;
  }

  const signalId = signal._id || signal.id;
  if (!signalId) return null;

  return {
    inline_keyboard: [[{ text: '⚡ Execute on MT5', callback_data: buildExecuteCallbackData(signalId) }]]
  };
}

async function notifySubscriber(subscriber, signalDoc) {
  if (!subscriber || !hasTierFeature(subscriber.subscription, 'telegramAlerts')) {
    return false;
  }

  const telegram = subscriber.telegram || {};
  if (!telegram.chatId || telegram.enabled === false) {
    return false;
  }

  const signal = signalDoc?.toObject ? signalDoc.toObject() : signalDoc;
  const text = formatSignalMessage(signal, subscriber);
  const replyMarkup = buildSignalReplyMarkup(signal, subscriber);
  const result = await sendMessage(telegram.chatId, text, { replyMarkup });
  return Boolean(result);
}

async function linkChatToUser(userId, chatId, username) {
  const telegram = {
    chatId: String(chatId),
    username: username || '',
    linkedAt: new Date(),
    enabled: true,
    linkCode: null,
    linkCodeExpiresAt: null
  };

  await persistUserTelegram(userId, telegram);
  return telegram;
}

async function unlinkUser(userId) {
  await persistUserTelegram(userId, {
    chatId: null,
    username: null,
    linkedAt: null,
    enabled: false,
    linkCode: null,
    linkCodeExpiresAt: null
  });
}

async function linkByCode(code, chatId, username) {
  const userId = consumeLinkCode(String(code || '').trim().toUpperCase());
  if (!userId) return { ok: false, reason: 'invalid_or_expired_code' };

  const user = await findUserById(userId);
  if (!user || !hasTierFeature(user.subscription, 'telegramAlerts')) {
    return { ok: false, reason: 'subscription_required' };
  }

  await linkChatToUser(userId, chatId, username);
  return { ok: true, userId, email: user.email };
}

async function getPublicStatus(user) {
  const config = getConfig();
  const telegram = user?.telegram || {};
  const tier = user?.subscription?.tier || 'basic';
  const enabledFeature = hasTierFeature(user?.subscription, 'telegramAlerts');

  return {
    configured: isConfigured(),
    featureEnabled: enabledFeature,
    linked: Boolean(telegram.chatId),
    enabled: telegram.enabled !== false,
    username: telegram.username || null,
    linkedAt: telegram.linkedAt || null,
    botUsername: config.botUsername,
    botUrl: getBotDeepLink(),
    tier: getTierDisplayName(tier)
  };
}

async function handleCommand(chatId, text, fromUsername) {
  const parts = String(text || '').trim().split(/\s+/);
  const command = (parts[0] || '').toLowerCase();
  const arg = parts[1] || '';

  if (command === '/start') {
    if (arg) {
      const linked = await linkByCode(arg, chatId, fromUsername);
      if (linked.ok) {
        await sendMessage(
          chatId,
          `✅ Linked to <b>${escapeHtml(linked.email)}</b>.\nYou will receive Kaching trade alerts here. Premium users can tap <b>Execute on MT5</b> to copy trades automatically.`
        );
        return;
      }
      await sendMessage(chatId, '❌ Link code invalid or expired. Generate a new code in the KachingScanner dashboard.');
      return;
    }

    await sendMessage(
      chatId,
      [
        '<b>Welcome to KachingScanner Trade Copier</b>',
        '',
        '1. Open KachingScanner → TradingView Setup → Telegram',
        '2. Generate a link code and send <code>/link YOUR_CODE</code> here',
        '3. Premium: install the MT5 EA and generate a link token in the dashboard',
        '4. When a signal arrives, tap <b>Execute on MT5</b> — entry, SL, TP, and lot size are filled for you'
      ].join('\n')
    );
    return;
  }

  if (command === '/link') {
    if (!arg) {
      await sendMessage(chatId, 'Usage: <code>/link ABCD1234</code>');
      return;
    }
    const linked = await linkByCode(arg, chatId, fromUsername);
    if (linked.ok) {
      await sendMessage(
        chatId,
        `✅ Linked to <b>${escapeHtml(linked.email)}</b>. Alerts are now enabled.`
      );
      return;
    }
    await sendMessage(chatId, '❌ Could not link account. Check your code and Pro/Premium subscription.');
    return;
  }

  if (command === '/unlink') {
    const user = await findUserByChatId(chatId);
    if (!user) {
      await sendMessage(chatId, 'No linked KachingScanner account found for this chat.');
      return;
    }
    await unlinkUser(user._id?.toString() || user.id);
    await sendMessage(chatId, '🔕 Telegram alerts unlinked.');
    return;
  }

  if (command === '/status') {
    const user = await findUserByChatId(chatId);
    if (!user) {
      await sendMessage(chatId, 'Not linked yet. Use <code>/link YOUR_CODE</code> from the dashboard.');
      return;
    }
    const status = await getPublicStatus(user);
    const mt5Status = await Mt5TradeCopierService.getPublicStatus(user);
    await sendMessage(
      chatId,
      [
        `<b>KachingScanner Trade Copier</b>`,
        `Plan: ${escapeHtml(status.tier)}`,
        `Telegram: ${status.linked ? 'linked' : 'not linked'} (${status.enabled ? 'alerts on' : 'alerts off'})`,
        mt5Status.featureEnabled
          ? `MT5: ${mt5Status.linked ? 'EA linked' : 'EA not linked'}${mt5Status.accountBalance ? ` | Balance: ${mt5Status.accountBalance} ${mt5Status.accountCurrency}` : ''}`
          : 'MT5 execution: upgrade to Premium'
      ].join('\n')
    );
    return;
  }

  if (command === '/help') {
    await sendMessage(
      chatId,
      [
        '<b>Commands</b>',
        '/link CODE — link your KachingScanner account',
        '/unlink — stop alerts in this chat',
        '/status — show link and trade copier status',
        '/help — show this message',
        '',
        '<b>Trade Copier</b>',
        'Premium users: link the MT5 EA in the dashboard, then tap Execute on any entry alert.'
      ].join('\n')
    );
  }
}

async function findUserByChatId(chatId) {
  const normalized = String(chatId);

  if (isDbConnected()) {
    return UserConfig.findOne({ 'telegram.chatId': normalized });
  }

  return devUserStore.findByChatId(normalized);
}

async function handleExecuteCallback(callbackQuery) {
  const callbackId = callbackQuery.id;
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const signalId = parseExecuteCallbackData(callbackQuery.data);

  if (!signalId) {
    await answerCallbackQuery(callbackId, 'Invalid action.', true);
    return;
  }

  const user = await findUserByChatId(chatId);
  if (!user) {
    await answerCallbackQuery(callbackId, 'Link your KachingScanner account first.', true);
    return;
  }

  const userId = user._id?.toString() || user.id;
  const result = await Mt5TradeCopierService.queueExecutionForUser(userId, signalId);

  if (!result.ok) {
    const messages = {
      subscription_required: 'MT5 execution requires Premium.',
      mt5_not_linked: 'Link the MT5 EA in your dashboard first.',
      mt5_disabled: 'MT5 trade copier is paused in your dashboard.',
      lot_size_unavailable: 'Sync your MT5 balance via the EA first.',
      already_queued: 'This trade is already queued or executed.',
      not_entry_signal: 'Only entry signals can be executed.',
      signal_not_found: 'Signal expired or not found.'
    };
    await answerCallbackQuery(callbackId, messages[result.reason] || 'Unable to queue trade.', true);
    return;
  }

  const summary = Mt5TradeCopierService.formatExecutionSummary(result.execution);
  await answerCallbackQuery(callbackId, 'Trade queued for MT5.');
  await sendMessage(
    chatId,
    `✅ <b>Trade queued for MT5</b>\n\n${escapeHtml(summary)}\n\nYour MT5 EA will execute this automatically.`
  );

  if (messageId) {
    await editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [[{ text: '✅ Queued for MT5', callback_data: 'noop' }]] });
  }
}

async function processUpdate(update) {
  if (update?.callback_query) {
    const data = update.callback_query.data || '';
    if (data.startsWith('exec:')) {
      await handleExecuteCallback(update.callback_query);
    } else if (data !== 'noop') {
      await answerCallbackQuery(update.callback_query.id);
    }
    return;
  }

  const message = update?.message;
  if (!message?.text || !message.chat?.id) return;

  const chatId = message.chat.id;
  const text = message.text;
  const username = message.from?.username || message.from?.first_name || '';

  if (text.startsWith('/')) {
    await handleCommand(chatId, text, username);
  }
}

async function handleWebhook(req) {
  const config = getConfig();
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && !config.webhookSecret) {
    return { ok: false, status: 503, message: 'Telegram webhook secret is not configured' };
  }

  if (config.webhookSecret) {
    const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
    const { timingSafeEqualString } = require('../utils/security');
    if (!timingSafeEqualString(String(headerSecret || ''), String(config.webhookSecret))) {
      return { ok: false, status: 401, message: 'Invalid Telegram webhook secret' };
    }
  }

  await processUpdate(req.body);
  return { ok: true, status: 200 };
}

async function pollOnce() {
  const updates = await apiRequest('getUpdates', {
    offset: pollingOffset,
    timeout: 30,
    allowed_updates: ['message', 'callback_query']
  });

  for (const update of updates) {
    pollingOffset = Math.max(pollingOffset, update.update_id + 1);
    await processUpdate(update);
  }
}

function startPolling() {
  if (pollingActive || !isConfigured() || !getConfig().usePolling) return;

  pollingActive = true;
  console.log('[Telegram] Polling mode enabled');

  const loop = async () => {
    while (pollingActive) {
      try {
        await pollOnce();
      } catch (error) {
        console.warn('[Telegram] polling error:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  };

  loop();
}

function stopPolling() {
  pollingActive = false;
}

module.exports = {
  isConfigured,
  getConfig,
  createLinkCode,
  unlinkUser,
  getPublicStatus,
  notifySubscriber,
  formatSignalMessage,
  sendMessage,
  handleWebhook,
  startPolling,
  stopPolling,
  getBotDeepLink
};
