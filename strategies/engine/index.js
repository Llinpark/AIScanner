/**
 * Strategy Engine public API — modular Strategy Profile architecture.
 */

const {
  assertStrategyProfile,
  normalizeStrategyProfile,
  toCatalogEntry
} = require('./StrategyProfile');
const {
  StrategyProfileRegistry,
  getProfileRegistry,
  setProfileRegistry,
  resetProfileRegistry
} = require('./StrategyProfileRegistry');
const {
  ScannerEngine,
  getScannerEngine,
  resetScannerEngine,
  bindScannerEngineToStrategyRegistry
} = require('./ScannerEngine');
const { buildStrategyContext, resolveHtfCandles } = require('./contextBuilder');
const { StubStrategy, createStubProfile } = require('./createStubStrategy');
const {
  bootstrapStrategyProfiles,
  resetBootstrapFlag,
  resolvePreferStrategyId,
  getLiveStrategyKeys
} = require('./bootstrap');
const { createScalpingProfile, createDayTradingProfile } = require('./liveProfiles');
const { createStubProfiles } = require('./stubProfiles');

module.exports = {
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
};
