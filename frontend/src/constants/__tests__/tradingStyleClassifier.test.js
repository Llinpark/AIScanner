import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TRADING_STYLES,
  detect,
  styleForTimeframe
} from '../tradingStyleClassifier.js';

describe('frontend TradingStyleClassifier', () => {
  it('classifies chart TFs for UI metadata', () => {
    assert.equal(styleForTimeframe('1m'), TRADING_STYLES.ULTRA_SCALPING);
    assert.equal(styleForTimeframe('5m'), TRADING_STYLES.SCALPING);
    assert.equal(styleForTimeframe('30m'), TRADING_STYLES.DAY_TRADING);
    assert.equal(styleForTimeframe('1h'), TRADING_STYLES.SWING_TRADING);
    assert.equal(styleForTimeframe('4h'), TRADING_STYLES.SWING_TRADING);
    assert.equal(styleForTimeframe('1d'), TRADING_STYLES.POSITION_TRADING);
    assert.equal(detect('Weekly').tradingStyle, TRADING_STYLES.POSITION_TRADING);
    assert.equal(detect('15m').advisoryOnly, true);
  });
});
