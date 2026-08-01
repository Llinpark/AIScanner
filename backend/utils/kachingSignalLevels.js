const KACHING_ALERT_NAMES = {
  entry: 'Kaching Entry',
  stop_loss: 'Kaching SL',
  take_profit_1: 'Kaching TP1',
  take_profit_2: 'Kaching TP2',
  take_profit_3: 'Kaching TP3',
  expired: 'Kaching Expired',
  cancelled: 'Kaching Cancelled',
  signal: 'Kaching Signal'
};

const REQUIRED_ENTRY_FIELDS = ['entry', 'stop_loss', 'take_profit_1', 'take_profit_2', 'take_profit_3'];

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Pass-through of TradingView webhook levels ONLY.
 * NEVER invents Entry/SL/TP from direction heuristics.
 */
function normalizeSignalLevels(body = {}) {
  const entry = parseOptionalNumber(body.entry ?? body.price);
  const stop_loss = parseOptionalNumber(body.stop_loss ?? body.stop_loss_1 ?? body.sl);
  const take_profit_1 = parseOptionalNumber(body.take_profit_1 ?? body.tp1);
  const take_profit_2 = parseOptionalNumber(body.take_profit_2 ?? body.tp2);
  const take_profit_3 = parseOptionalNumber(body.take_profit_3 ?? body.tp3);

  return {
    entry: entry ?? undefined,
    stop_loss: stop_loss ?? undefined,
    stop_loss_1: stop_loss ?? undefined,
    take_profit_1: take_profit_1 ?? undefined,
    take_profit_2: take_profit_2 ?? undefined,
    take_profit_3: take_profit_3 ?? undefined
  };
}

function isStructuredEntryAlert(body = {}) {
  const alertType = String(body.alertType || body.alert_type || body.type || '').toLowerCase();
  return (
    alertType === 'entry' ||
    body.pattern === 'perfect_fvg' ||
    body.pattern === 'breakaway_gap' ||
    body.pattern === 'liquidity_sweep_fvg_scalp' ||
    body.pattern === 'liquidity_sweep_fvg_daytrading' ||
    body.pattern === 'smc_pipeline'
  );
}

function validateKachingEntrySignal(signalData) {
  if (!isStructuredEntryAlert(signalData)) {
    return;
  }

  const missing = REQUIRED_ENTRY_FIELDS.filter(field => {
    const value = parseOptionalNumber(signalData[field]);
    return value == null || value === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `Invalid Kaching entry signal: TradingView must send Entry, SL, TP1, TP2, and TP3 ` +
        `(${missing.join(', ')} missing). Levels are never invented server-side.`
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
