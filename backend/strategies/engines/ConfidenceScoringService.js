/**
 * ConfidenceScoringService — 0–100 weighted score.
 * Supports scalping weights (sweep/mss/…) and daytrading weights (htfBias/optionalConfirmation).
 */

class ConfidenceScoringService {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {Object} factors - boolean map keyed by weight names
   * @returns {{ score: number, breakdown: Object, passesThreshold: boolean, threshold: number }}
   */
  score(factors = {}) {
    const weights = this.config.confidence?.weights || {
      sweep: 30,
      mss: 20,
      displacement: 15,
      fvg: 15,
      retrace: 10,
      engulfing: 5,
      doji: 5
    };
    const threshold = this.config.confidence?.threshold ?? 70;

    /** @type {Record<string, number>} */
    const breakdown = {};
    for (const key of Object.keys(weights)) {
      const w = weights[key] || 0;
      breakdown[key] = factors[key] ? w : 0;
    }

    // Allow extra factor keys present in factors but not in default weights (no-op if weight missing)
    for (const key of Object.keys(factors)) {
      if (!(key in breakdown) && weights[key]) {
        breakdown[key] = factors[key] ? weights[key] : 0;
      }
    }

    const score = Object.values(breakdown).reduce((a, b) => a + b, 0);

    return {
      score,
      breakdown,
      passesThreshold: score >= threshold,
      threshold
    };
  }
}

module.exports = { ConfidenceScoringService };
