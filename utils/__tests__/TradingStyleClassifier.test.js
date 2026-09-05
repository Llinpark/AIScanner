/**
 * TradingStyleClassifier — advisory TF → style mapping (never a reject gate).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  TRADING_STYLES,
  detect,
  styleForTimeframe,
  classifyForStrategy,
  normalizeChartTimeframe,
  buildPineTradingStyleExpression
} = require('../TradingStyleClassifier');
const { TradeSignalGenerator } = require('../../strategies/engines/TradeSignalGenerator');

describe('TradingStyleClassifier', () => {
  it('maps 1m → Ultra Scalping', () => {
    assert.equal(styleForTimeframe('1m'), TRADING_STYLES.ULTRA_SCALPING);
    assert.equal(detect('1m').tradingStyle, 'Ultra Scalping');
  });

  it('maps 3m/5m → Scalping', () => {
    assert.equal(styleForTimeframe('3m'), TRADING_STYLES.SCALPING);
    assert.equal(styleForTimeframe('5m'), TRADING_STYLES.SCALPING);
  });

  it('maps 15m/30m → Day Trading', () => {
    assert.equal(styleForTimeframe('15m'), TRADING_STYLES.DAY_TRADING);
    assert.equal(styleForTimeframe('30m'), TRADING_STYLES.DAY_TRADING);
    assert.equal(detect('30m').tradingStyle, 'Day Trading');
  });

  it('maps 1H/4H → Swing Trading', () => {
    assert.equal(styleForTimeframe('1h'), TRADING_STYLES.SWING_TRADING);
    assert.equal(styleForTimeframe('4h'), TRADING_STYLES.SWING_TRADING);
    assert.equal(detect('60').tradingStyle, 'Swing Trading');
    assert.equal(detect('240').tradingStyle, 'Swing Trading');
  });

  it('maps Daily/Weekly → Position Trading', () => {
    assert.equal(styleForTimeframe('1d'), TRADING_STYLES.POSITION_TRADING);
    assert.equal(styleForTimeframe('1w'), TRADING_STYLES.POSITION_TRADING);
    assert.equal(detect('Daily').tradingStyle, 'Position Trading');
    assert.equal(detect('Weekly').tradingStyle, 'Position Trading');
  });

  it('returns advisory metadata fields without reject semantics', () => {
    const meta = detect('30m', {
      higherTimeframe: '1h',
      preferredEntryTimeframes: ['5m', '15m']
    });
    assert.equal(meta.tradingStyle, 'Day Trading');
    assert.equal(meta.chartTimeframe, '30m');
    assert.equal(meta.entryTimeframe, '30m');
    assert.equal(meta.higherTimeframe, '1h');
    assert.equal(meta.isPreferredEntryTf, false);
    assert.equal(meta.advisoryOnly, true);
  });

  it('classifyForStrategy attaches preferred Scalping / Day Trading lists', () => {
    const scalp = classifyForStrategy('3m', 'scalping');
    assert.equal(scalp.tradingStyle, 'Scalping');
    assert.equal(scalp.isPreferredEntryTf, true);
    assert.ok(scalp.preferredEntryTimeframes.includes('3m'));

    const dayOn30 = classifyForStrategy('30m', 'daytrading');
    assert.equal(dayOn30.tradingStyle, 'Day Trading');
    assert.equal(dayOn30.isPreferredEntryTf, false);
  });

  it('normalizes Pine-style and alias TFs', () => {
    assert.equal(normalizeChartTimeframe('15'), '15m');
    assert.equal(normalizeChartTimeframe('H1'), '1h');
    assert.equal(normalizeChartTimeframe('1D'), '1d');
  });

  it('builds Pine tradingStyle expression covering all style buckets', () => {
    const expr = buildPineTradingStyleExpression();
    assert.match(expr, /Ultra Scalping/);
    assert.match(expr, /Swing Trading/);
    assert.match(expr, /Position Trading/);
    assert.match(expr, /multiplier == 30/);
  });
});

describe('Webhook payload schema unchanged by style metadata', () => {
  it('toTradingViewPayload keeps required fields and omits tradingStyle', () => {
    const gen = new TradeSignalGenerator({
      name: 'Liquidity Sweep + Fair Value Gap (Scalping)',
      id: 'liquidity_sweep_fvg_scalp'
    });
    const signal = gen.generate({
      symbol: 'XAUUSD',
      direction: 'long',
      entry: 2000,
      stop_loss: 1990,
      take_profit_1: 2010,
      take_profit_2: 2020,
      take_profit_3: 2030,
      confidence: 80,
      timeframe: '3m'
    });
    signal.tradingStyle = 'Scalping';
    signal.chartTimeframe = '3m';
    signal.higherTimeframe = '15m';

    const payload = gen.toTradingViewPayload(signal);
    const required = [
      'symbol',
      'strategyName',
      'timeframe',
      'pattern',
      'alertType',
      'direction',
      'entry',
      'stop_loss',
      'stop_loss_1',
      'take_profit_1',
      'take_profit_2',
      'take_profit_3',
      'gapTop',
      'gapBottom',
      'confidence',
      'message',
      'broadcast'
    ];
    for (const key of required) {
      assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `missing ${key}`);
    }
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'tradingStyle'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'chartTimeframe'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'higherTimeframe'), false);
    assert.equal(payload.alertType, 'entry');
    assert.equal(payload.broadcast, true);
  });
});
