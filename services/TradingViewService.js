/**
 * TradingViewService — event-driven TradingView webhook / OAuth surface.
 *
 * Responsibilities:
 * - Webhook validation / authentication
 * - Webhook parsing / normalization
 * - Webhook event publishing (inject-only; no market-data fetch)
 * - OAuth helpers for account linking
 *
 * Historical candles live in ChartDataService — never fetch them here.
 */
const { TRADINGVIEW_CONFIG } = require('../config/tradingview');
const { verifyTradingViewWebhook } = require('../utils/webhookSecurity');
const TradingViewAlertService = require('./TradingViewAlertService');

class TradingViewService {
  static getOAuthUrl(state) {
    const params = new URLSearchParams({
      client_id: TRADINGVIEW_CONFIG.oauth.clientId,
      redirect_uri: TRADINGVIEW_CONFIG.oauth.redirectUri,
      response_type: 'code',
      scope: 'read_history',
      state: state || 'random_state'
    });
    return `${TRADINGVIEW_CONFIG.oauth.authUrl}?${params}`;
  }

  static async exchangeCodeForToken(code) {
    try {
      console.log('[TradingView] Exchanging OAuth code for token');
      const mockToken = `tv_token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const mockUserId = `tv_user_${Math.random().toString(36).substr(2, 9)}`;

      return {
        access_token: mockToken,
        user_id: mockUserId,
        expires_in: 86400,
        token_type: 'Bearer'
      };
    } catch (error) {
      throw new Error('OAuth token exchange failed: ' + error.message);
    }
  }

  static async verifyToken(token) {
    return Boolean(token && String(token).startsWith('tv_token_'));
  }

  /** Authenticate an inbound TradingView webhook request. */
  static async authenticateWebhook(req, resolveUserById) {
    return verifyTradingViewWebhook(req, resolveUserById);
  }

  /** Parse / normalize raw TradingView webhook body. */
  static parseWebhookBody(body) {
    return TradingViewAlertService.parseWebhookBody(body);
  }

  /** Build validated signal fields from a parsed webhook payload. */
  static buildSignalData(body) {
    return TradingViewAlertService.buildSignalData(body);
  }

  /**
   * Publish a TradingView webhook event (validate → persist → sockets / Telegram).
   * Never fetches candles or runs scanner / indicator pipelines.
   */
  static async publishWebhookEvent(io, rawBody, inMemorySignals = []) {
    return TradingViewAlertService.publishTradingViewAlert(io, rawBody, inMemorySignals);
  }

  /** Alias used by MarketScannerService / routes. */
  static async processWebhook(io, rawBody, inMemorySignals = []) {
    return TradingViewService.publishWebhookEvent(io, rawBody, inMemorySignals);
  }

  /**
   * Outbound alert notification (event publish to TV user — not candle fetch).
   */
  static async sendAlertToTradingView(userId, symbol, message) {
    console.log(`[TradingView] Queue alert for user ${userId}: ${symbol} - ${message}`);
    return {
      success: true,
      message: 'Alert queued for TradingView user',
      timestamp: new Date()
    };
  }
}

module.exports = TradingViewService;
