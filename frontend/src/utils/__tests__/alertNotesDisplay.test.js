import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLiteralNewlines, liveAlertNotesText } from '../alertNotesDisplay.js';

describe('live alert notes display', () => {
  it('turns literal backslash-n into real newlines', () => {
    const decoded = decodeLiteralNewlines('🟦 Kaching BUY\\nEntry: 4641.695\\nSL: 4639.836');
    assert.equal(decoded.includes('\\n'), false);
    assert.equal(decoded, '🟦 Kaching BUY\nEntry: 4641.695\nSL: 4639.836');
  });

  it('hides Pine/telegram dumps when Entry/SL/TP are already structured', () => {
    const alert = {
      entry: 4641.695,
      stop_loss: 4639.836,
      take_profit_1: 4644.483,
      notes: '🟦 Kaching BUY\\nEntry: 4641.695\\nSL: 4639.836\\nTP1: 4644.483'
    };
    assert.equal(liveAlertNotesText(alert), '');
  });

  it('still shows short labels that are not a level dump', () => {
    assert.equal(
      liveAlertNotesText({ entry: 1.17, stop_loss: 1.16, notes: 'Kaching TP1' }),
      'Kaching TP1'
    );
  });
});
