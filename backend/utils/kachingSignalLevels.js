const KACHING_ALERT_NAMES = {
  entry: 'Kaching Entry',
  stop_loss: 'Kaching SL',
  take_profit_1: 'Kaching TP1',
  take_profit_2: 'Kaching TP2',
  take_profit_3: 'Kaching TP3',
  signal: 'Kaching Signal'
};

const REQUIRED_ENTRY_FIELDS = ['entry', 'stop_loss', 'take_profit_1', 'take_profit_2', 'take_profit_3'];

function parseNumber(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSignalLevels(body = {}, direction = 'neutral') {
  const entry = parseNumber(body.entry ?? body.price);
  const stop_loss = parseNumber(body.stop_loss ?? body.stop_loss_1 ?? body.sl);
  const take_profit_1 = parseNumber(body.take_profit_1 ?? body.tp1);
  const take_profit_2 = parseNumber(body.take_profit_2 ?? body.tp2);
  const take_profit_3 = parseNumber(body.take_profit_3 ?? body.tp3);

  const safeEntry = entry || 0;
  const safeStop = stop_loss || (safeEntry ? safeEntry * (direction === 'short' ? 1.005 : 0.995) : 0);
  const safeTp1 =
    take_profit_1 || (safeEntry ? (direction === 'short' ? safeEntry * 0.99 : safeEntry * 1.01) : 0);
  const safeTp2 =
    take_profit_2 || (safeEntry ? (direction === 'short' ? safeEntry * 0.98 : safeEntry * 1.02) : 0);
  const safeTp3 =
    take_profit_3 || (safeEntry ? (direction === 'short' ? safeEntry * 0.965 : safeEntry * 1.035) : 0);

  return {
    entry: safeEntry,
    stop_loss: safeStop,
    stop_loss_1: safeStop,
    take_profit_1: safeTp1,
    take_profit_2: safeTp2,
    take_profit_3: safeTp3
  };
}

function isStructuredEntryAlert(body = {}) {
  const alertType = String(body.alertType || body.alert_type || body.type || '').toLowerCase();
  return alertType === 'entry' || body.pattern === 'perfect_fvg' || body.pattern === 'breakaway_gap';
}

function validateKachingEntrySignal(signalData) {
  if (!isStructuredEntryAlert(signalData)) {
    return;
  }

  const missing = REQUIRED_ENTRY_FIELDS.filter(field => !parseNumber(signalData[field]));
  if (missing.length > 0) {
    throw new Error(
      `Invalid Kaching entry signal: each entry must include Kaching Entry, Kaching SL, Kaching TP1, Kaching TP2, and Kaching TP3 (${missing.join(', ')} missing)`
    );
  }
}

function formatKachingAlertMessage(signal) {
  const typeLabel = KACHING_ALERT_NAMES[signal.alertType] || KACHING_ALERT_NAMES.signal;
  const sl = signal.stop_loss ?? signal.stop_loss_1;
  return `${typeLabel} ${String(signal.direction || 'neutral').toUpperCase()} ${signal.symbol} | ${KACHING_ALERT_NAMES.entry} ${signal.entry} | ${KACHING_ALERT_NAMES.stop_loss} ${sl} | ${KACHING_ALERT_NAMES.take_profit_1} ${signal.take_profit_1} | ${KACHING_ALERT_NAMES.take_profit_2} ${signal.take_profit_2} | ${KACHING_ALERT_NAMES.take_profit_3} ${signal.take_profit_3}`;
}

module.exports = {
  KACHING_ALERT_NAMES,
  REQUIRED_ENTRY_FIELDS,
  normalizeSignalLevels,
  isStructuredEntryAlert,
  validateKachingEntrySignal,
  formatKachingAlertMessage
};
