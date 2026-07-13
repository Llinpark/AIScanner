const { computeRiskMetrics } = require('../utils/signalRisk');
const { generateTradeExplanation } = require('../utils/signalExplanation');
const { enrichEntrySignal, isEntryAlert } = require('../utils/signalOutcome');

function enrichSignal(signalData, options = {}) {
  const alertType = signalData.alertType || 'signal';
  let payload = { ...signalData };

  if (isEntryAlert(alertType)) {
    payload = enrichEntrySignal(payload);
  }

  const riskMetrics = computeRiskMetrics(payload, options);
  if (riskMetrics) {
    payload.riskMetrics = riskMetrics;
  }

  payload.tradeExplanation = generateTradeExplanation(payload, riskMetrics);
  return payload;
}

module.exports = {
  enrichSignal
};
