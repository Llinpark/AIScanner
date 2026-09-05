const { KACHING_ALERT_NAMES } = require('./kachingSignalLevels');
const { isEntryAlert } = require('./signalOutcome');

const MANAGEMENT_MESSAGES = {
  stop_loss: 'Stop loss hit — position closed. Review risk and journal the trade.',
  take_profit_1: 'TP1 hit — consider partial close and move stop toward break-even.',
  take_profit_2: 'TP2 hit — bank more profit; trail remaining size.',
  take_profit_3: 'TP3 hit — final target reached. Close or secure runners.',
  signal: 'Trade management update from TradingView.'
};

/**
 * Build Premium trade-management metadata for SL / TP lifecycle alerts.
 * Entry alerts are not management alerts.
 */
function buildTradeManagement(signal) {
  const alertType = String(signal?.alertType || 'signal').toLowerCase();
  if (isEntryAlert(alertType)) return null;

  const label = KACHING_ALERT_NAMES[alertType] || alertType;
  return {
    kind: alertType,
    label,
    stage:
      alertType === 'stop_loss'
        ? 'sl'
        : alertType === 'take_profit_1'
          ? 'tp1'
          : alertType === 'take_profit_2'
            ? 'tp2'
            : alertType === 'take_profit_3'
              ? 'tp3'
              : 'update',
    message: MANAGEMENT_MESSAGES[alertType] || MANAGEMENT_MESSAGES.signal,
    at: new Date().toISOString()
  };
}

function attachTradeManagementToSignal(signal) {
  const tradeManagement = buildTradeManagement(signal);
  if (!tradeManagement) return signal;

  const patch = { ...signal, tradeManagement };
  if (tradeManagement.stage === 'tp1' || tradeManagement.stage === 'tp2') {
    patch.partialClose = {
      suggested: true,
      stage: tradeManagement.stage,
      note: tradeManagement.message
    };
  }
  if (tradeManagement.stage === 'tp1') {
    patch.breakEven = {
      suggested: true,
      note: 'Consider moving SL to break-even after TP1.'
    };
  }
  return patch;
}

module.exports = {
  buildTradeManagement,
  attachTradeManagementToSignal
};
