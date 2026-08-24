/**
 * Live Alerts notes may contain a two-char "\n" from Pine JSON (not a trading field).
 * Decode those for display, and hide the blob when Entry/SL/TP are already structured.
 */

export function decodeLiteralNewlines(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n');
}

function hasStructuredLevels(alert = {}) {
  const present = value => value != null && value !== '';
  return (
    present(alert.entry) ||
    present(alert.stop_loss) ||
    present(alert.stop_loss_1) ||
    present(alert.take_profit_1)
  );
}

function looksLikeLevelDump(text) {
  const decoded = decodeLiteralNewlines(text);
  return /Entry\s*:/i.test(decoded) && /SL\s*:/i.test(decoded);
}

export function liveAlertNotesText(alert = {}) {
  const raw = alert.message || alert.notes || '';
  if (!raw) return '';
  if (hasStructuredLevels(alert) && looksLikeLevelDump(raw)) return '';
  return decodeLiteralNewlines(raw).trim();
}
