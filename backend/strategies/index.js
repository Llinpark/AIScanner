/**
 * Public API for the pluggable strategy layer.
 */

const { IStrategy, assertStrategy } = require('./interfaces/IStrategy');
const {
  StrategyRegistry,
  createDefaultRegistry,
  getDefaultRegistry,
  resetDefaultRegistry
} = require('./registry');
const { ScalpingStrategy } = require('./ScalpingStrategy');
const { DayTradingStrategy, DAYTRADING_ID, DAYTRADING_NAME } = require('./DayTradingStrategy');
const {
  LegacySmcPipelineStrategy,
  LEGACY_SMC_ID,
  LEGACY_SMC_NAME
} = require('./LegacySmcPipelineStrategy');
const {
  STRATEGY_ID: SCALPING_ID,
  STRATEGY_NAME: SCALPING_NAME,
  DEFAULT_SCALPING_CONFIG,
  resolveScalpingConfig
} = require('./config/scalpingConfig');
const {
  STRATEGY_ID: DAYTRADING_SWEEP_ID,
  STRATEGY_NAME: DAYTRADING_SWEEP_NAME,
  DEFAULT_DAYTRADING_CONFIG,
  resolveDayTradingConfig
} = require('./config/dayTradingConfig');
const { LiquidityDetector } = require('./detectors/LiquidityDetector');
const { LiquiditySweepDetector } = require('./detectors/LiquiditySweepDetector');
const { MarketStructureShiftDetector } = require('./detectors/MarketStructureShiftDetector');
const { DisplacementDetector } = require('./detectors/DisplacementDetector');
const { EngulfingDetector } = require('./detectors/EngulfingDetector');
const { FairValueGapDetector } = require('./detectors/FairValueGapDetector');
const { RetracementDetector } = require('./detectors/RetracementDetector');
const { EntryEngine } = require('./engines/EntryEngine');
const { RiskManager } = require('./engines/RiskManager');
const { TakeProfitEngine } = require('./engines/TakeProfitEngine');
const { ConfidenceScoringService } = require('./engines/ConfidenceScoringService');
const { TradeSignalGenerator } = require('./engines/TradeSignalGenerator');
const { HTFBiasService } = require('./services/HTFBiasService');
const { TrendFilter } = require('./services/TrendFilter');
const { NewsFilter } = require('./services/NewsFilter');
const { SymbolStateCache, globalSymbolStateCache } = require('./utils/SymbolStateCache');
const candleMath = require('./utils/candleMath');

module.exports = {
  IStrategy,
  assertStrategy,
  StrategyRegistry,
  createDefaultRegistry,
  getDefaultRegistry,
  resetDefaultRegistry,
  ScalpingStrategy,
  DayTradingStrategy,
  LegacySmcPipelineStrategy,
  DAYTRADING_ID,
  DAYTRADING_NAME,
  DAYTRADING_SWEEP_ID,
  DAYTRADING_SWEEP_NAME,
  LEGACY_SMC_ID,
  LEGACY_SMC_NAME,
  SCALPING_ID,
  SCALPING_NAME,
  DEFAULT_SCALPING_CONFIG,
  resolveScalpingConfig,
  DEFAULT_DAYTRADING_CONFIG,
  resolveDayTradingConfig,
  LiquidityDetector,
  LiquiditySweepDetector,
  MarketStructureShiftDetector,
  DisplacementDetector,
  EngulfingDetector,
  FairValueGapDetector,
  RetracementDetector,
  EntryEngine,
  RiskManager,
  TakeProfitEngine,
  ConfidenceScoringService,
  TradeSignalGenerator,
  HTFBiasService,
  TrendFilter,
  NewsFilter,
  SymbolStateCache,
  globalSymbolStateCache,
  candleMath
};
