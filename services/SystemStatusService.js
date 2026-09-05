/**
 * System / distribution status for the dashboard Signal Status panel.
 * Chart feed health is reported separately and must never gate signal delivery.
 */
function createSystemStatusService({
  PythonAiService,
  TelegramService,
  Mt5TradeCopierService,
  MarketScannerService,
  getMarketDataHub,
  mongoose
} = {}) {
  async function getDistributionStatus(user = null) {
    const autoScanEnabled = Boolean(MarketScannerService?.getScannerStatus?.()?.autoScanEnabled);
    const hub = typeof getMarketDataHub === 'function' ? getMarketDataHub() : null;
    let chartFeed = { state: 'unknown', message: null };
    try {
      const status = hub?.getStatus?.() || hub?.status?.() || null;
      if (status?.rateLimited || status?.unavailable) {
        chartFeed = {
          state: 'degraded',
          message: 'Chart Feed Temporarily unavailable. Signals continue operating normally.'
        };
      } else if (status?.redisConnected === false && status?.providerReady === false) {
        chartFeed = {
          state: 'degraded',
          message: 'Chart Feed Temporarily unavailable. Signals continue operating normally.'
        };
      } else {
        chartFeed = { state: 'online', message: null };
      }
    } catch {
      chartFeed = {
        state: 'degraded',
        message: 'Chart Feed Temporarily unavailable. Signals continue operating normally.'
      };
    }

    const telegramLinked = Boolean(user?.telegram?.chatId || user?.telegram?.linked);
    const mt5Linked =
      Array.isArray(user?.mt5?.devices) && user.mt5.devices.some(d => d && !d.revokedAt);

    return {
      architecture: 'tradingview_webhook_distribution',
      signalEngine: {
        state: 'online',
        mode: 'distribution',
        label: 'Signal Engine',
        detail: 'Distributes TradingView webhook signals (does not generate from live providers)'
      },
      tradingView: {
        state: 'connected',
        label: 'TradingView',
        detail: 'Pine strategy → webhook is the signal source'
      },
      webhook: {
        state: 'receiving',
        label: 'Webhook',
        detail: 'Publish-only ingest; no candle fetch'
      },
      telegram: {
        state: telegramLinked ? 'connected' : user ? 'idle' : 'available',
        label: 'Telegram',
        linked: telegramLinked
      },
      mt5: {
        state: mt5Linked ? 'connected' : user ? 'idle' : 'available',
        label: 'MT5',
        linked: mt5Linked
      },
      chartFeed: {
        ...chartFeed,
        label: 'Chart Feed',
        isolatedFromSignals: true
      },
      pythonAi: {
        configured: Boolean(PythonAiService?.isConfigured?.()),
        state: PythonAiService?.isConfigured?.() ? 'online' : 'unconfigured',
        label: 'AI Analytics',
        detail: 'Optional descriptive analytics — not the trade signal source'
      },
      autoScanEnabled,
      dbState: mongoose?.connection?.readyState ?? null
    };
  }

  return { getDistributionStatus };
}

module.exports = { createSystemStatusService };
