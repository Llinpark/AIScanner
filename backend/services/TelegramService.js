const crypto = require('crypto');
const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const devUserStore = require('../utils/devUserStore');
const { WEBHOOK_TELEGRAM_URL } = require('../config/appUrls');
const {
  userHasTierFeature,
  getEffectiveSubscription,
  getTierDisplayName,
  isSubscriptionActive,
  hasTierFeature
} = require('../utils/subscriptionAccess');
const { formatKachingAlertMessage } = require('../utils/kachingSignalLevels');
const { isEntryAlert } = require('../utils/signalOutcome');
const { formatTvPrice } = require('../utils/priceFormat');
const Mt5TradeCopierService = require('./Mt5TradeCopierService');

const LINK_CODE_TTL_MS = 15 * 60 * 1000;
const ALLOWED_UPDATES = ['message', 'callback_query'];
const linkCodeIndex = new Map();
let pollingActive = false;
let pollingOffset = 0;

function getConfig() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    botUsername: (process.env.TELEGRAM_BOT_USERNAME || 'KachingAIBot').replace(/^@/, ''),
    usePolling: process.env.TELEGRAM_USE_POLLING === 'true',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    webhookUrl: (process.env.WEBHOOK_TELEGRAM_URL || WEBHOOK_TELEGRAM_URL || '').replace(/\/$/, '')
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

function purgeExpiredMemoryCodes() {
  const now = Date.now();
  for (const [code, entry] of linkCodeIndex.entries()) {
    if (!entry?.expiresAt || new Date(entry.expiresAt).getTime() < now) {
      linkCodeIndex.delete(code);
    }
  }
}

/** Drop any in-memory codes previously issued for this user (new code replaces them). */
function clearMemoryCodesForUser(userId) {
  const id = String(userId);
  for (const [code, entry] of linkCodeIndex.entries()) {
    if (String(entry?.userId) === id) {
      linkCodeIndex.delete(code);
    }
  }
}

async function findUserByLinkCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;

  if (isDbConnected()) {
    return UserConfig.findOne({ 'telegram.linkCode': normalized });
  }
  return devUserStore.findByLinkCode(normalized);
}

/**
 * Resolve a link code from the in-memory index, with DB fallback.
 * Codes are persisted on the user document so redemption still works after
 * process restarts or when the webhook hits a different instance.
 */
async function resolveLinkCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;

  purgeExpiredMemoryCodes();

  const memoryEntry = linkCodeIndex.get(normalized);
  if (memoryEntry) {
    if (new Date(memoryEntry.expiresAt) < new Date()) {
      linkCodeIndex.delete(normalized);
    } else {
      return { userId: String(memoryEntry.userId), expiresAt: memoryEntry.expiresAt, source: 'memory' };
    }
  }

  const user = await findUserByLinkCode(normalized);
  if (!user) return null;

  const expiresAt = user.telegram?.linkCodeExpiresAt;
  if (!expiresAt || new Date(expiresAt) < new Date()) {
    return null;
  }

  const userId = user._id?.toString?.() || user.id;
  // Warm memory so subsequent lookups on this process are cheap.
  storeLinkCode(normalized, userId, new Date(expiresAt));
  return { userId: String(userId), expiresAt: new Date(expiresAt), source: 'db' };
}

async function invalidateLinkCode(code, userId) {
  const normalized = String(code || '').trim().toUpperCase();
  if (normalized) {
    linkCodeIndex.delete(normalized);
  }

  if (!userId) return;

  const current = await getTelegramState(userId);
  if (!current.linkCode && !current.linkCodeExpiresAt) return;

  await persistUserTelegram(userId, {
    ...current,
    linkCode: null,
    linkCodeExpiresAt: null
  });
}

async function createLinkCode(userId) {
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);

  clearMemoryCodesForUser(userId);
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

function formatSignalMessage(signal, subscriber = null, options = {}) {
  const includeExecuteButton = Boolean(options.includeExecuteButton);
  const alertType = signal.alertType || 'signal';
  const title = escapeHtml(formatKachingAlertMessage(signal).split('|')[0]?.trim() || 'Kaching Alert');
  const sl = signal.stop_loss_1 ?? signal.stop_loss;
  const lines = [
    `<b>${title}</b>`,
    `<b>Symbol:</b> ${escapeHtml(signal.symbol)}`,
    `<b>Direction:</b> ${escapeHtml(String(signal.direction || '').toUpperCase())}`,
    `<b>Kaching Entry:</b> ${formatTvPrice(signal.entry)}`,
    `<b>Kaching SL:</b> ${formatTvPrice(sl)}`,
    `<b>Kaching TP1:</b> ${formatTvPrice(signal.take_profit_1)}`,
    `<b>Kaching TP2:</b> ${formatTvPrice(signal.take_profit_2)}`,
    `<b>Kaching TP3:</b> ${formatTvPrice(signal.take_profit_3)}`
  ];

  if (subscriber && userHasTierFeature(subscriber, 'autoLotSizing')) {
    const lotSize = Mt5TradeCopierService.computeLotSize(signal, subscriber);
    if (lotSize) {
      lines.push(`<b>Auto Lot Size:</b> ${Number(lotSize).toFixed(2)}`);
    }
  }

  if (subscriber && userHasTierFeature(subscriber, 'showConfidence') && signal.confidence != null) {
    lines.push(`<b>Confidence:</b> ${Math.round(Number(signal.confidence) * 100)}%`);
  }

  if (subscriber && userHasTierFeature(subscriber, 'aiTradeExplanation') && signal.tradeExplanation) {
    lines.push(`\n<i>${escapeHtml(signal.tradeExplanation)}</i>`);
  }

  if (subscriber && userHasTierFeature(subscriber, 'tradeManagementAlerts') && signal.tradeManagement?.message) {
    lines.push(`\n<b>Management:</b> <i>${escapeHtml(signal.tradeManagement.message)}</i>`);
  }

  if (includeExecuteButton && isEntryAlert(alertType)) {
    const secs = Number(options.confirmSeconds) || 180;
    const windowLabel = secs % 60 === 0 ? `${secs / 60} min` : `${secs}s`;
    lines.push(
      `\n<i>Pro Manual Confirmation — tap <b>Execute Trade</b> within ${windowLabel} to queue MT5. ` +
        `After expiry this signal is marked Expired and will not execute. Tap <b>Ignore Trade</b> to discard. ` +
        `Once queued, the EA manages SL/TP/BE/trail/partials — no further Telegram steps.</i>`
    );
  }

  return lines.filter(Boolean).join('\n');
}

function buildExecuteCallbackData(signalId) {
  return `exec:${String(signalId)}`.slice(0, 64);
}

function buildIgnoreCallbackData(signalId) {
  return `ign:${String(signalId)}`.slice(0, 64);
}

function parseExecuteCallbackData(data) {
  const raw = String(data || '');
  if (!raw.startsWith('exec:')) return null;
  return raw.slice(5);
}

function parseIgnoreCallbackData(data) {
  const raw = String(data || '');
  if (!raw.startsWith('ign:')) return null;
  return raw.slice(4);
}

function buildSignalReplyMarkup(signal, subscriber, { includeExecuteButton = false } = {}) {
  if (!includeExecuteButton) return null;
  if (!subscriber || !userHasTierFeature(subscriber, 'mt5Execution')) {
    return null;
  }

  if (!isEntryAlert(signal.alertType || 'signal')) {
    return null;
  }

  const mt5 = subscriber.mt5 || {};
  const hasDevice = Array.isArray(mt5.devices) && mt5.devices.some(d => d && !d.revokedAt);
  if (!hasDevice || mt5.enabled === false) {
    return null;
  }

  const signalId = signal._id || signal.id;
  if (!signalId) return null;

  return {
    inline_keyboard: [
      [
        { text: '⚡ Execute Trade', callback_data: buildExecuteCallbackData(signalId) },
        { text: '✖ Ignore Trade', callback_data: buildIgnoreCallbackData(signalId) }
      ]
    ]
  };
}

/**
 * Notification-only channel. Execute button is opt-in via options (Manual mode).
 * MT5 auto-queue is owned by TradeDeliveryService — not Telegram.
 */
async function notifySubscriber(subscriber, signalDoc, options = {}) {
  if (!subscriber || !userHasTierFeature(subscriber, 'telegramAlerts')) {
    return false;
  }

  const telegram = subscriber.telegram || {};
  if (!telegram.chatId || telegram.enabled === false) {
    return false;
  }

  const includeExecuteButton = Boolean(options.includeExecuteButton);
  const signal = signalDoc?.toObject ? signalDoc.toObject() : signalDoc;
  const text = formatSignalMessage(signal, subscriber, options);
  const replyMarkup = buildSignalReplyMarkup(signal, subscriber, { includeExecuteButton });
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
  const normalized = String(code || '').trim().toUpperCase();
  const resolved = await resolveLinkCode(normalized);
  if (!resolved) return { ok: false, reason: 'invalid_or_expired_code' };

  const user = await findUserById(resolved.userId);
  if (!user) {
    await invalidateLinkCode(normalized, resolved.userId);
    return { ok: false, reason: 'invalid_or_expired_code' };
  }

  const subscription = getEffectiveSubscription(user);
  if (!isSubscriptionActive(subscription) || !hasTierFeature(subscription, 'telegramAlerts')) {
    // Keep the code so the user can retry after renewing/upgrading (still within TTL).
    return { ok: false, reason: 'subscription_required' };
  }

  // Burn the one-time code (memory + DB) then attach this chat.
  linkCodeIndex.delete(normalized);
  await linkChatToUser(resolved.userId, chatId, username);
  return { ok: true, userId: resolved.userId, email: user.email };
}

async function sendLinkFailure(chatId, reason) {
  if (reason === 'subscription_required') {
    await sendMessage(
      chatId,
      '❌ Could not link account. Telegram alerts require an active Pro or Premium subscription.'
    );
    return;
  }
  await sendMessage(
    chatId,
    '❌ Link code invalid or expired. Generate a new code in the KachingScanner dashboard (codes expire in 15 minutes).'
  );
}

async function getPublicStatus(user) {
  const config = getConfig();
  const telegram = user?.telegram || {};
  const tier = getEffectiveSubscription(user).tier || 'basic';
  const enabledFeature = userHasTierFeature(user, 'telegramAlerts');

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
  // Telegram may send "/link@BotName" in groups — strip the bot suffix.
  const command = (parts[0] || '').toLowerCase().split('@')[0];
  const arg = parts[1] || '';

  if (command === '/start') {
    if (arg) {
      const linked = await linkByCode(arg, chatId, fromUsername);
      if (linked.ok) {
        await sendMessage(
          chatId,
          `✅ Linked to <b>${escapeHtml(linked.email)}</b>.\nYou will receive Kaching trade alerts here. In Manual mode, tap <b>Execute on MT5</b> to queue a trade.`
        );
        return;
      }
      await sendLinkFailure(chatId, linked.reason);
      return;
    }

    await sendMessage(
      chatId,
      [
        '<b>Welcome to KachingScanner alerts</b>',
        '',
        '1. Open KachingScanner → Auto Trading',
        '2. Generate a Telegram link code and send <code>/link YOUR_CODE</code> here',
        '3. Pro/Premium: connect the MT5 EA in the dashboard (independent of Telegram)',
        '4. Manual mode: tap <b>Execute on MT5</b> on entry alerts to queue the trade',
        '5. Premium Auto mode: trades queue for MT5 automatically — Telegram is notification-only'
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
    await sendLinkFailure(chatId, linked.reason);
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
        `<b>KachingScanner Auto Trading</b>`,
        `Plan: ${escapeHtml(status.tier)}`,
        `Telegram: ${status.linked ? 'linked' : 'not linked'} (${status.enabled ? 'alerts on' : 'alerts off'})`,
        mt5Status.featureEnabled
          ? `MT5: ${mt5Status.linked ? 'EA linked' : 'EA not linked'} | Mode: ${mt5Status.executionMode}${mt5Status.accountBalance ? ` | Balance: ${mt5Status.accountBalance} ${mt5Status.accountCurrency}` : ''}`
          : 'MT5 execution: upgrade to Pro or Premium'
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
        '/status — show link and auto trading status',
        '/help — show this message',
        '',
        '<b>Auto Trading</b>',
        'Telegram is notifications only. Pair MT5 in the dashboard.',
        'Pro Manual Confirmation: Execute Trade / Ignore Trade (time-limited).',
        'Premium Automatic: queues MT5 immediately; Telegram is informational only.'
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
  // Manual Execute only — queues via TradeDeliveryService (source=manual).
  const TradeDeliveryService = require('./TradeDeliveryService');
  const result = await TradeDeliveryService.queueManualExecution(userId, signalId);

  if (!result.ok) {
    const messages = {
      subscription_required: 'MT5 execution requires Pro or Premium.',
      mt5_not_linked: 'Pair MT5 in your dashboard first.',
      mt5_disabled: 'MT5 auto trading is paused in your dashboard.',
      lot_size_unavailable:
        'Premium: sync MT5 balance via the EA first. Pro: set a fixed lot size in the dashboard.',
      already_queued: 'This trade is already queued or executed.',
      not_entry_signal: 'Only entry signals can be executed.',
      signal_not_found: 'Signal not found.',
      confirm_expired: 'Confirmation expired — signal marked Expired. Not queued.',
      confirm_ignored: 'This trade was ignored.',
      forbidden: 'Not allowed.'
    };
    await answerCallbackQuery(callbackId, messages[result.reason] || 'Unable to queue trade.', true);
    if (result.reason === 'confirm_expired' && messageId) {
      await editMessageReplyMarkup(chatId, messageId, {
        inline_keyboard: [[{ text: '⏰ Expired — not queued', callback_data: 'noop' }]]
      });
    }
    return;
  }

  const summary = Mt5TradeCopierService.formatExecutionSummary(result.execution);
  await answerCallbackQuery(callbackId, 'Trade queued for MT5.');
  await sendMessage(
    chatId,
    `✅ <b>Trade queued for MT5</b>\n\n${escapeHtml(summary)}\n\n` +
      `Your EA will execute and fully manage SL/TP1–TP3/BE/trail/partials — no further confirmation needed.`
  );

  if (messageId) {
    await editMessageReplyMarkup(chatId, messageId, {
      inline_keyboard: [[{ text: '✅ Queued for MT5', callback_data: 'noop' }]]
    });
  }
}

async function handleIgnoreCallback(callbackQuery) {
  const callbackId = callbackQuery.id;
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const signalId = parseIgnoreCallbackData(callbackQuery.data);

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
  const TradeDeliveryService = require('./TradeDeliveryService');
  const result = await TradeDeliveryService.ignoreManualExecution(userId, signalId);

  if (!result.ok) {
    const messages = {
      signal_not_found: 'Signal not found.',
      already_queued: 'Already queued — cannot ignore.',
      confirm_expired: 'Already expired.',
      forbidden: 'Not allowed.'
    };
    await answerCallbackQuery(callbackId, messages[result.reason] || 'Unable to ignore.', true);
    return;
  }

  await answerCallbackQuery(callbackId, 'Trade ignored — not queued.');
  if (messageId) {
    await editMessageReplyMarkup(chatId, messageId, {
      inline_keyboard: [[{ text: '✖ Ignored — not queued', callback_data: 'noop' }]]
    });
  }
}

async function processUpdate(update) {
  if (update?.callback_query) {
    const data = update.callback_query.data || '';
    if (data.startsWith('exec:')) {
      await handleExecuteCallback(update.callback_query);
    } else if (data.startsWith('ign:')) {
      await handleIgnoreCallback(update.callback_query);
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
    allowed_updates: ALLOWED_UPDATES
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

async function clearWebhook() {
  await apiRequest('deleteWebhook', { drop_pending_updates: false });
}

async function registerWebhook() {
  const config = getConfig();
  const url = config.webhookUrl;

  if (!url) {
    console.error('[Telegram] Webhook URL missing (set WEBHOOK_TELEGRAM_URL or PUBLIC_BACKEND_URL); skipping setWebhook');
    return { ok: false, reason: 'missing_url' };
  }

  if (!config.webhookSecret) {
    console.error('[Telegram] TELEGRAM_WEBHOOK_SECRET is required for webhook mode; skipping setWebhook');
    return { ok: false, reason: 'missing_secret' };
  }

  await apiRequest('setWebhook', {
    url,
    secret_token: config.webhookSecret,
    allowed_updates: ALLOWED_UPDATES
  });

  return { ok: true, url };
}

/**
 * Startup delivery mode:
 * - polling (local): deleteWebhook then start getUpdates loop
 * - webhook (prod): setWebhook with public URL + secret_token
 * Never logs bot token or webhook secret.
 */
async function ensureDeliveryMode() {
  if (!isConfigured()) {
    console.log('[Telegram] Bot token not set; delivery mode skipped');
    return { ok: false, reason: 'not_configured' };
  }

  const config = getConfig();

  if (config.usePolling) {
    try {
      await clearWebhook();
      console.log('[Telegram] Webhook cleared for polling mode');
    } catch (error) {
      console.warn('[Telegram] deleteWebhook failed (continuing to poll):', error.message);
    }
    startPolling();
    return { ok: true, mode: 'polling' };
  }

  try {
    const result = await registerWebhook();
    if (result.ok) {
      console.log(`[Telegram] Webhook registered (mode=webhook) url=${result.url}`);
    }
    return { ...result, mode: 'webhook' };
  } catch (error) {
    console.error(`[Telegram] setWebhook failed (mode=webhook) url=${config.webhookUrl}:`, error.message);
    return { ok: false, mode: 'webhook', reason: 'set_webhook_failed', error: error.message };
  }
}

module.exports = {
  isConfigured,
  getConfig,
  createLinkCode,
  linkByCode,
  unlinkUser,
  getPublicStatus,
  notifySubscriber,
  formatSignalMessage,
  sendMessage,
  handleWebhook,
  startPolling,
  stopPolling,
  ensureDeliveryMode,
  getBotDeepLink,
  // Test helpers
  _resolveLinkCode: resolveLinkCode,
  _clearLinkCodeIndex: () => linkCodeIndex.clear()
};
