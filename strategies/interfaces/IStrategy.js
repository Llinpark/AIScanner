/**
 * @typedef {import('../types').StrategyContext} StrategyContext
 * @typedef {import('../types').StrategyResult} StrategyResult
 *
 * IStrategy — pluggable strategy contract.
 * Every strategy must expose: id, name, enabled, analyze(context).
 */

/**
 * @interface IStrategy
 */
class IStrategy {
  /** @returns {string} */
  get id() {
    throw new Error('IStrategy.id not implemented');
  }

  /** @returns {string} */
  get name() {
    throw new Error('IStrategy.name not implemented');
  }

  /** @returns {boolean} */
  get enabled() {
    return true;
  }

  /**
   * @param {StrategyContext} _context
   * @returns {StrategyResult|Promise<StrategyResult>}
   */
  analyze(_context) {
    throw new Error('IStrategy.analyze not implemented');
  }
}

/**
 * Runtime duck-type check for registry registration.
 * @param {Object} strategy
 */
function assertStrategy(strategy) {
  if (!strategy || typeof strategy.analyze !== 'function') {
    throw new Error('Strategy must implement analyze(context)');
  }
  if (!strategy.id || !strategy.name) {
    throw new Error('Strategy must expose id and name');
  }
  return strategy;
}

module.exports = { IStrategy, assertStrategy };
