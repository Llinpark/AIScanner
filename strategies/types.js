/**
 * Shared typedefs for the pluggable strategy layer.
 * Runtime is CommonJS JS; JSDoc provides the TypeScript-style contract.
 *
 * @typedef {'long'|'short'} TradeDirection
 *
 * @typedef {Object} Candle
 * @property {number} time - Unix ms (or seconds; callers normalize)
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} [volume]
 *
 * @typedef {Object} SwingPoint
 * @property {number} index
 * @property {number} price
 * @property {number} time
 * @property {'high'|'low'} type
 *
 * @typedef {Object} LiquidityPool
 * @property {string} type - previous_swing_high|previous_swing_low|equal_highs|equal_lows|pdh|pdl|asian_high|asian_low|london_high|london_low|ny_high|ny_low
 * @property {number} price
 * @property {number} [time]
 * @property {number} [index]
 * @property {'buy_side'|'sell_side'} side
 * @property {number} [sweepCount]
 *
 * @typedef {Object} LiquiditySweep
 * @property {TradeDirection} direction - long after sell-side sweep, short after buy-side
 * @property {string} liquidityType
 * @property {number} level
 * @property {number} sweepPrice - extreme beyond the level
 * @property {number} time
 * @property {number} sweepIndex
 * @property {Candle} sweepCandle
 * @property {LiquidityPool} pool
 *
 * @typedef {Object} MarketStructureShift
 * @property {TradeDirection} direction
 * @property {number} breakPrice
 * @property {number} breakIndex
 * @property {number} structureLevel
 * @property {string} reason
 *
 * @typedef {Object} DisplacementResult
 * @property {boolean} passed
 * @property {TradeDirection} [direction]
 * @property {number} [index]
 * @property {number} [bodyRatio]
 * @property {number} [rangeToAtr]
 * @property {string} [reason]
 *
 * @typedef {Object} EngulfingResult
 * @property {boolean} found
 * @property {TradeDirection} [direction]
 * @property {number} [index]
 *
 * @typedef {Object} FairValueGap
 * @property {TradeDirection} direction
 * @property {number} gapTop
 * @property {number} gapBottom
 * @property {number} gapSize
 * @property {number} ce - 50% equilibrium
 * @property {number} c1Index
 * @property {number} c2Index
 * @property {number} c3Index
 * @property {boolean} [hasDojiOnC3]
 *
 * @typedef {Object} RetracementResult
 * @property {boolean} passed
 * @property {number} [entryPrice]
 * @property {string} [model]
 * @property {string} [reason]
 *
 * @typedef {Object} TradeLevels
 * @property {number} entry
 * @property {number} stop_loss
 * @property {number} take_profit_1
 * @property {number} take_profit_2
 * @property {number} take_profit_3
 * @property {number} [risk]
 * @property {number} [rr]
 *
 * @typedef {Object} InternalTradeSignal
 * @property {TradeDirection} direction
 * @property {number} entry
 * @property {number} stop_loss
 * @property {number} take_profit_1
 * @property {number} take_profit_2
 * @property {number} take_profit_3
 * @property {number} rr
 * @property {string} liquidityType
 * @property {number} liquidityLevel
 * @property {{ top: number, bottom: number, ce: number, size: number }} fvg
 * @property {number} confidence
 * @property {string[]} reasons
 * @property {number|string} timestamp
 * @property {string} timeframe
 * @property {string} strategyName
 * @property {string} [symbol]
 * @property {string} [pattern]
 * @property {string} [patternLabel]
 * @property {string} [alertType]
 *
 * @typedef {Object} StrategyContext
 * @property {string} symbol
 * @property {Candle[]} candles - entry TF (scalping: 3m/5m; day trading: 5m/15m)
 * @property {Candle[]} [htfCandles] - HTF context (scalping: 15m; day trading: 1h/4h)
 * @property {string} [timeframe]
 * @property {string} [htfTimeframe]
 * @property {Object} [state] - incremental SymbolStateCache
 * @property {number} [spread]
 * @property {Date|number} [now]
 * @property {Object} [config]
 *
 * @typedef {Object} StrategyResult
 * @property {boolean} signal
 * @property {InternalTradeSignal|null} [entry]
 * @property {Object|null} [pending]
 * @property {string} [stage]
 * @property {string} [reason]
 * @property {Object} [diagnostics]
 */

module.exports = {};
