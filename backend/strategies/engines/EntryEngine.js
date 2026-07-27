/**
 * EntryEngine — resolves entry price from FVG retracement model.
 */

class EntryEngine {
  /**
   * @param {Object} [config]
   * @param {import('../detectors/RetracementDetector').RetracementDetector} retracementDetector
   */
  constructor(config, retracementDetector) {
    this.config = config;
    this.retracementDetector = retracementDetector;
  }

  /**
   * @param {Object} params
   * @param {import('../types').FairValueGap} params.fvg
   * @param {import('../types').TradeDirection} params.direction
   * @param {import('../types').RetracementResult} params.retrace
   * @returns {{ entry: number, model: string }|null}
   */
  resolve({ fvg, direction, retrace }) {
    if (!retrace?.passed || !Number.isFinite(retrace.entryPrice)) {
      return null;
    }

    const model = retrace.model || this.config.entry?.model || 'ce';
    let entry = retrace.entryPrice;

    // CE default: pin exactly to equilibrium when model says so
    if (model === 'ce') {
      entry = fvg.ce;
    }

    return { entry, model, direction };
  }
}

module.exports = { EntryEngine };
