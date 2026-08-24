/**
 * Subscriber-facing presentation for durable Signals.
 * Input: normalized Signal / trade object — NEVER a raw TradingView webhook body.
 * Output: email / Telegram / dashboard text. Raw JSON must never be the fallback.
 */

const { createHash } = require('crypto');
const { formatTvPrice } = require('../utils/priceFormat');
const { toCompactSymbol, getSymbolAssetClass } = require('../config/symbols');
const {
  isEntryAlert,
  isTerminalEntry,
  isOutcomeAlert
} = require('../utils/signalOutcome');
const { KACHING_ALERT_NAMES } = require('../utils/kachingSignalLevels');

const EMAIL_FOOTER = 'KachingScanner / Your Trading Partner';

const FORMATTING_FALLBACK =
  '⚠️ A Kaching trading alert was received, but the trade levels could not be formatted correctly.';

const RAW_PAYLOAD_KEYS = [
  'licenseToken',
  'signalUuid',
  'canonicalSignalKey',
  'scriptGenerationId',
  'generatedAt',
  'tradingviewUsername'
];

function parseLevel(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Field aliasing for durable Signal / trade objects (not webhook ingest).
 * stop_loss / stopLoss / stop_loss_1 → SL; take_profit_1 / takeProfit1 / tp1 → TP1.
 */
function resolveLevels(signal = {}) {
  const sl = parseLevel(
    signal.stop_loss ??
      signal.stopLoss ??
      signal.stop_loss_1 ??
      signal.stopLoss1 ??
      signal.sl
  );
  return {
    entry: parseLevel(signal.entry ?? signal.price ?? signal.entryPrice),
    sl,
    tp1: parseLevel(
      signal.take_profit_1 ?? signal.takeProfit1 ?? signal.take_profit1 ?? signal.tp1
    ),
    tp2: parseLevel(
      signal.take_profit_2 ?? signal.takeProfit2 ?? signal.take_profit2 ?? signal.tp2
    ),
    tp3: parseLevel(
      signal.take_profit_3 ?? signal.takeProfit3 ?? signal.take_profit3 ?? signal.tp3
    )
  };
}

function resolveSide(signal = {}) {
  const raw = String(signal.direction || signal.action || signal.side || '')
    .trim()
    .toLowerCase();
  if (raw === 'long' || raw === 'buy') return 'BUY';
  if (raw === 'short' || raw === 'sell') return 'SELL';
  return '';
}

function resolveDisplaySymbol(signal = {}) {
  const compact = toCompactSymbol(signal.symbol || signal.ticker || '');
  return compact || String(signal.symbol || signal.ticker || '').trim();
}

function resolveAlertType(signal = {}) {
  return String(signal.alertType || signal.alert_type || signal.type || 'signal')
    .trim()
    .toLowerCase();
}

/**
 * Symbol-aware display decimals. Reuses mintick inference only when the
 * instrument class is unknown.
 */
function decimalsForSymbol(symbol) {
  const compact = String(toCompactSymbol(symbol) || symbol || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!compact) return null;
  if (compact.includes('JPY')) return 3;
  if (compact.includes('XAU') || compact.includes('GOLD')) return 2;
  if (compact.includes('XAG') || compact.includes('SILVER')) return 3;
  const cls = getSymbolAssetClass(symbol);
  if (cls === 'gold') return 2;
  if (cls === 'indices') return 2;
  if (cls === 'crypto') return 2;
  if (cls === 'metal') return 3;
  if (cls === 'forex') return 5;
  return null;
}

function formatSubscriberPrice(value, symbol) {
  const n = parseLevel(value);
  if (n == null) return null;
  const decimals = decimalsForSymbol(symbol);
  if (decimals != null) return n.toFixed(decimals);
  return formatTvPrice(n);
}

function hashSafeId(signal = {}) {
  const raw = String(signal._id || signal.id || '').trim();
  if (!raw) return 'none';
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function looksLikeRawPayload(content) {
  const text = String(content || '');
  if (!text.trim()) return false;
  const trimmed = text.trim();
  if (/^\{\s*"symbol"\s*:/.test(trimmed)) return true;
  if (/^\{\s*"ticker"\s*:/.test(trimmed)) return true;
  return RAW_PAYLOAD_KEYS.some(key => text.includes(key));
}

/**
 * Pine JSON cannot embed real newlines (invalid JSON), and Pine v5 "\n" is the
 * letter n — not LF — so templates emit a two-char backslash-n. jsonEsc then
 * preserves that as a literal "\n" after JSON.parse. That is not a trading
 * field; convert it (and double-escaped \\n) to real line breaks.
 */
function decodeLiteralNewlines(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

function sanitizeSubscriberNotes(raw) {
  const text = decodeLiteralNewlines(raw).trim();
  if (!text) return KACHING_ALERT_NAMES.signal;
  if (looksLikeRawPayload(text)) return KACHING_ALERT_NAMES.signal;
  if (text.startsWith('{') || text.startsWith('[')) return KACHING_ALERT_NAMES.signal;
  return text;
}

function logBlockedRawPayload({ channel, symbol, alertType, safeId, reason }) {
  console.warn(
    `[SUBSCRIBER_MESSAGE_BLOCKED_RAW_PAYLOAD] channel=${channel || 'n/a'} ` +
      `symbol=${symbol || 'n/a'} alertType=${alertType || 'n/a'} ` +
      `id=${safeId || 'none'} reason=${reason || 'raw_payload'}`
  );
}

function assertSafeSubscriberContent(content, meta = {}) {
  const text = String(content || '');
  if (!looksLikeRawPayload(text)) {
    return { blocked: false, text };
  }
  logBlockedRawPayload({
    channel: meta.channel,
    symbol: meta.symbol,
    alertType: meta.alertType,
    safeId: meta.safeId || hashSafeId(meta.signal),
    reason: /^\{\s*"symbol"\s*:/.test(text.trim()) ? 'json_symbol_payload' : 'sensitive_key'
  });
  return { blocked: true, text: null, reason: 'blocked_raw_payload' };
}

/**
 * Stale ENTRY must not be fanned out as a fresh trade.
 * Uses durable timestamps / terminal state — never provider-candle close.
 */
function isStaleFreshEntry(signal = {}, now = new Date()) {
  const alertType = resolveAlertType(signal);
  if (!isEntryAlert(alertType)) return false;
  if (isTerminalEntry(signal)) return true;
  if (signal.closedAt) return true;
  const stage = String(signal.lifecycleStage || '').toUpperCase();
  if (['TP3', 'SL', 'EXPIRED', 'CANCELLED', 'COMPLETED'].includes(stage)) return true;
  if (signal.expiresAt) {
    const exp = new Date(signal.expiresAt);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) return true;
  }
  return false;
}

function appendLevelLines(lines, levels, symbol, { telegram }) {
  const fmt = value => formatSubscriberPrice(value, symbol);
  const prefix = telegram ? '🎯 ' : '';
  if (levels.tp1 != null) lines.push(`${prefix}TP1: ${fmt(levels.tp1)}`);
  if (levels.tp2 != null) lines.push(`${prefix}TP2: ${fmt(levels.tp2)}`);
  if (levels.tp3 != null) lines.push(`${prefix}TP3: ${fmt(levels.tp3)}`);
}

function buildEntryEmailBody(side, symbol, levels) {
  const lines = [`KACHING ${side} SIGNAL`, '', symbol, ''];
  if (levels.entry != null) {
    lines.push(`Entry: ${formatSubscriberPrice(levels.entry, symbol)}`);
    lines.push('');
  }
  const tpLines = [];
  appendLevelLines(tpLines, levels, symbol, { telegram: false });
  if (tpLines.length) {
    lines.push('Take Profits');
    lines.push(...tpLines);
    lines.push('');
  }
  if (levels.sl != null) {
    lines.push('Stop Loss');
    lines.push(`SL: ${formatSubscriberPrice(levels.sl, symbol)}`);
    lines.push('');
  }
  lines.push(EMAIL_FOOTER);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function buildEntryTelegramBody(side, symbol, levels) {
  const emoji = side === 'BUY' ? '🟢' : '🔴';
  const lines = [`${emoji} KACHING ${side}`, '', symbol, ''];
  if (levels.entry != null) {
    lines.push(`📍 Entry: ${formatSubscriberPrice(levels.entry, symbol)}`);
    lines.push('');
  }
  appendLevelLines(lines, levels, symbol, { telegram: true });
  if (levels.sl != null) {
    lines.push('');
    lines.push(`🛑 SL: ${formatSubscriberPrice(levels.sl, symbol)}`);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function lifecycleHeadline(alertType) {
  if (alertType === 'take_profit_1' || alertType === 'take_profit_2') {
    return { telegram: '🎯 KACHING UPDATE', email: 'KACHING UPDATE', subjectKind: 'UPDATE' };
  }
  if (alertType === 'take_profit_3') {
    return {
      telegram: '🏆 KACHING TRADE COMPLETE',
      email: 'KACHING TRADE COMPLETE',
      subjectKind: 'TRADE COMPLETE'
    };
  }
  if (alertType === 'stop_loss') {
    return {
      telegram: '🛑 KACHING TRADE CLOSED',
      email: 'KACHING TRADE CLOSED',
      subjectKind: 'TRADE CLOSED'
    };
  }
  if (alertType === 'expired') {
    return {
      telegram: '🛑 KACHING TRADE CLOSED',
      email: 'KACHING TRADE CLOSED',
      subjectKind: 'TRADE CLOSED'
    };
  }
  if (alertType === 'cancelled') {
    return {
      telegram: '🛑 KACHING TRADE CLOSED',
      email: 'KACHING TRADE CLOSED',
      subjectKind: 'TRADE CLOSED'
    };
  }
  return null;
}

function lifecycleHitLabel(alertType) {
  if (alertType === 'take_profit_1') return 'TP1 HIT';
  if (alertType === 'take_profit_2') return 'TP2 HIT';
  if (alertType === 'take_profit_3') return 'TP3 HIT';
  if (alertType === 'stop_loss') return 'SL HIT';
  if (alertType === 'expired') return 'EXPIRED';
  if (alertType === 'cancelled') return 'CANCELLED';
  return String(alertType || '').toUpperCase();
}

function emailToHtml(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<pre style="font-family:inherit;white-space:pre-wrap;margin:0">${escaped}</pre>`;
}

function presentationFailure(signal, reason) {
  return {
    ok: false,
    reason,
    stale: reason === 'stale_entry',
    blocked: false,
    subject: null,
    text: null,
    html: null,
    telegramText: null,
    dashboardText: null,
    fallbackText: FORMATTING_FALLBACK,
    kind: 'error',
    symbol: resolveDisplaySymbol(signal),
    alertType: resolveAlertType(signal),
    side: resolveSide(signal),
    safeId: hashSafeId(signal)
  };
}

function finalizePresentation(base, { channel } = {}) {
  const samples = [base.subject, base.text, base.telegramText, base.dashboardText].filter(Boolean);
  for (const sample of samples) {
    const guard = assertSafeSubscriberContent(sample, {
      channel: channel || base.kind || 'subscriber',
      symbol: base.symbol,
      alertType: base.alertType,
      safeId: base.safeId
    });
    if (guard.blocked) {
      return {
        ...base,
        ok: false,
        blocked: true,
        reason: 'blocked_raw_payload',
        subject: null,
        text: null,
        html: null,
        telegramText: null,
        dashboardText: null,
        fallbackText: FORMATTING_FALLBACK
      };
    }
  }
  return base;
}

function formatPresentation(signalDoc, options = {}) {
  const signal = signalDoc?.toObject ? signalDoc.toObject() : signalDoc || {};
  const now = options.now instanceof Date ? options.now : new Date();

  if (isStaleFreshEntry(signal, now)) {
    return presentationFailure(signal, 'stale_entry');
  }

  const symbol = resolveDisplaySymbol(signal);
  const side = resolveSide(signal);
  const levels = resolveLevels(signal);
  const alertType = resolveAlertType(signal);
  const safeId = hashSafeId(signal);

  try {
    if (!symbol) {
      console.warn('[SubscriberSignalFormatter] formatting failed: missing symbol');
      return presentationFailure(signal, 'formatting_failed');
    }

    if (isEntryAlert(alertType)) {
      if (!side || levels.entry == null) {
        console.warn(
          `[SubscriberSignalFormatter] formatting failed: entry requires side+entry symbol=${symbol}`
        );
        return presentationFailure(signal, 'formatting_failed');
      }
      const text = buildEntryEmailBody(side, symbol, levels);
      const telegramText = buildEntryTelegramBody(side, symbol, levels);
      return finalizePresentation(
        {
          ok: true,
          reason: null,
          stale: false,
          blocked: false,
          kind: 'entry',
          side,
          symbol,
          alertType,
          safeId,
          subject: `Kaching ${side} — ${symbol}`,
          text,
          html: emailToHtml(text),
          telegramText,
          dashboardText: telegramText,
          fallbackText: FORMATTING_FALLBACK,
          levels
        },
        { channel: options.channel }
      );
    }

    const headline = lifecycleHeadline(alertType);
    if (headline && (isOutcomeAlert(alertType) || alertType === 'expired' || alertType === 'cancelled')) {
      const hit = lifecycleHitLabel(alertType);
      const emailLines = [headline.email, '', symbol, '', hit, ''];
      if (levels.entry != null) {
        emailLines.push(`Entry: ${formatSubscriberPrice(levels.entry, symbol)}`);
        emailLines.push('');
      }
      const tpLines = [];
      appendLevelLines(tpLines, levels, symbol, { telegram: false });
      if (tpLines.length) {
        emailLines.push('Take Profits');
        emailLines.push(...tpLines);
        emailLines.push('');
      }
      if (levels.sl != null) {
        emailLines.push('Stop Loss');
        emailLines.push(`SL: ${formatSubscriberPrice(levels.sl, symbol)}`);
        emailLines.push('');
      }
      emailLines.push(EMAIL_FOOTER);
      const text = emailLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';

      const tgLines = [headline.telegram, '', symbol, '', hit];
      if (levels.entry != null) {
        tgLines.push('');
        tgLines.push(`📍 Entry: ${formatSubscriberPrice(levels.entry, symbol)}`);
      }
      const tgTp = [];
      appendLevelLines(tgTp, levels, symbol, { telegram: true });
      if (tgTp.length) {
        tgLines.push('');
        tgLines.push(...tgTp);
      }
      if (levels.sl != null) {
        tgLines.push('');
        tgLines.push(`🛑 SL: ${formatSubscriberPrice(levels.sl, symbol)}`);
      }
      const telegramText = tgLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();

      return finalizePresentation(
        {
          ok: true,
          reason: null,
          stale: false,
          blocked: false,
          kind: 'lifecycle',
          side,
          symbol,
          alertType,
          safeId,
          subject: `Kaching ${headline.subjectKind} — ${symbol}`,
          text,
          html: emailToHtml(text),
          telegramText,
          dashboardText: telegramText,
          fallbackText: FORMATTING_FALLBACK,
          levels
        },
        { channel: options.channel }
      );
    }

    console.warn(
      `[SubscriberSignalFormatter] formatting failed: unsupported alertType=${alertType} symbol=${symbol}`
    );
    return presentationFailure(signal, 'formatting_failed');
  } catch (err) {
    console.warn(`[SubscriberSignalFormatter] formatting failed: ${err.message}`);
    return presentationFailure(signal, 'formatting_failed');
  }
}

function formatEmail(signal, options = {}) {
  return formatPresentation(signal, { ...options, channel: 'email' });
}

function formatTelegram(signal, options = {}) {
  return formatPresentation(signal, { ...options, channel: 'telegram' });
}

function formatDashboard(signal, options = {}) {
  return formatPresentation(signal, { ...options, channel: 'dashboard' });
}

module.exports = {
  EMAIL_FOOTER,
  FORMATTING_FALLBACK,
  RAW_PAYLOAD_KEYS,
  resolveLevels,
  resolveSide,
  resolveDisplaySymbol,
  formatSubscriberPrice,
  decimalsForSymbol,
  looksLikeRawPayload,
  decodeLiteralNewlines,
  sanitizeSubscriberNotes,
  assertSafeSubscriberContent,
  isStaleFreshEntry,
  hashSafeId,
  formatPresentation,
  formatEmail,
  formatTelegram,
  formatDashboard
};
