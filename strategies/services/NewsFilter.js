/**
 * NewsFilter — configurable blackout around major news (0 / 30 / 60 / 90 min).
 * Wraps backend/utils/newsFilter with strategy-level windowing.
 */

const { evaluateNewsImpact, isFirstFriday } = require('../../utils/newsFilter');

class NewsFilter {
  /**
   * @param {Object} [config]
   */
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * @param {Date|number} [now]
   * @returns {{ blocked: boolean, impact: string, label: string, windowMinutes: number, reason?: string }}
   */
  evaluate(now = new Date()) {
    const filters = this.config.filters || {};
    if (filters.rejectOnMajorNews === false) {
      return { blocked: false, impact: 'none', label: 'news_filter_disabled', windowMinutes: 0 };
    }

    const windowMinutes = Number(filters.newsWindowMinutes ?? 60);
    if (windowMinutes <= 0) {
      return { blocked: false, impact: 'none', label: 'news_window_disabled', windowMinutes: 0 };
    }

    const at = now instanceof Date ? now : new Date(now);
    const base = evaluateNewsImpact(at);

    // Expand NFP / high-impact windows by configured minutes before/after the core window
    if (base.impact === 'high' || this._inExpandedHighImpact(at, windowMinutes)) {
      return {
        blocked: true,
        impact: 'high',
        label: base.label || 'Major news blackout',
        windowMinutes,
        reason: 'major_news_active'
      };
    }

    // Medium impact only blocks when window >= 60
    if (base.impact === 'medium' && windowMinutes >= 60 && base.window === 'us_data') {
      return {
        blocked: true,
        impact: 'medium',
        label: base.label,
        windowMinutes,
        reason: 'news_data_window'
      };
    }

    return {
      blocked: false,
      impact: base.impact,
      label: base.label,
      windowMinutes
    };
  }

  /** @private */
  _inExpandedHighImpact(at, windowMinutes) {
    // NFP first Friday ~12:30–14:30 UTC — expand by windowMinutes
    if (!isFirstFriday(at)) return false;
    const mins = at.getUTCHours() * 60 + at.getUTCMinutes();
    const coreStart = 12 * 60 + 30;
    const coreEnd = 14 * 60 + 30;
    return mins >= coreStart - windowMinutes && mins <= coreEnd + windowMinutes;
  }
}

module.exports = { NewsFilter };
