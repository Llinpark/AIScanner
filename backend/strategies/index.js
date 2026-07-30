/**
 * Public API for the pluggable strategy layer + Strategy Engine.
 */

const { IStrategy, assertStrategy } = require('./interfaces/IStrategy');
const {
  StrategyRegistry,
  createDefaultRegistry,
  getDefaultRegistry,
  resetDefaultRegistry,
  setDefaultRegistry
} = require('./registry');
const {
  assertStrategyProfile,
  normalizeStrategyProfile,
  toCatalogEntry,
  StrategyProfileRegistry,
  getProfileRegistry,
  setProfileRegistry,
  resetProfileRegistry,
  ScannerEngine,
  getScannerEngine,
  resetScannerEngine,
  bindScannerEngineToStrategyRegistry,
  buildStrategyContext,
  resolveHtfCandles,
  StubStrategy,
  createStubProfile,
  bootstrapStrategyProfiles,
  resetBootstrapFlag,
  resolvePreferStrategyId,
  getLiveStrategyKeys,
  createScalpingProfile,
  createDayTradingProfile,
  createStubProfiles
} = require('./engine');
const { ScalpingStrategy } = require('./ScalpingStrategy');
const { DayTradingStrategy, DAYTRADING_ID, DAYTRADING_NAME } = require('./DayTradingStrategy');
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
const {
  TakeProfitEngine,
  DEFAULT_LIQUIDITY_PRIORITY,
  DEFAULT_SCORE_WEIGHTS,
  DEFAULT_SCORE_PROXIMITY,
  SCALP_ATR_CAPS,
  DAY_ATR_CAPS
} = require('./engines/TakeProfitEngine');
const {
  SCALPING_TP_PROFILE,
  DAY_TRADING_TP_PROFILE,
  SYSTEM_DEFAULT_TP_PROFILE,
  TP_PROFILE_REGISTRY,
  getTpProfile,
  resolveTpProfile,
  registerTpProfile
} = require('./profiles');
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
  setDefaultRegistry,
  // Strategy Engine
  assertStrategyProfile,
  normalizeStrategyProfile,
  toCatalogEntry,
  StrategyProfileRegistry,
  getProfileRegistry,
  setProfileRegistry,
  resetProfileRegistry,
  ScannerEngine,
  getScannerEngine,
  resetScannerEngine,
  bindScannerEngineToStrategyRegistry,
  buildStrategyContext,
  resolveHtfCandles,
  StubStrategy,
  createStubProfile,
  bootstrapStrategyProfiles,
  resetBootstrapFlag,
  resolvePreferStrategyId,
  getLiveStrategyKeys,
  createScalpingProfile,
  createDayTradingProfile,
  createStubProfiles,
  ScalpingStrategy,
  DayTradingStrategy,
  DAYTRADING_ID,
  DAYTRADING_NAME,
  DAYTRADING_SWEEP_ID,
  DAYTRADING_SWEEP_NAME,
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
  DEFAULT_LIQUIDITY_PRIORITY,
  DEFAULT_SCORE_WEIGHTS,
  DEFAULT_SCORE_PROXIMITY,
  SCALP_ATR_CAPS,
  DAY_ATR_CAPS,
  SCALPING_TP_PROFILE,
  DAY_TRADING_TP_PROFILE,
  SYSTEM_DEFAULT_TP_PROFILE,
  TP_PROFILE_REGISTRY,
  getTpProfile,
  resolveTpProfile,
  registerTpProfile,
  ConfidenceScoringService,
  TradeSignalGenerator,
  HTFBiasService,
  TrendFilter,
  NewsFilter,
  SymbolStateCache,
  globalSymbolStateCache,
  candleMath
};
