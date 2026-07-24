export default function TradingViewSetup() {
  return (
    <section className="tradingview-setup">
      <div className="setup-header">
        <h2>TradingView Alert Setup</h2>
        <p>
          Connect TradingView to Kaching so alerts from any chart instrument appear on the dashboard, Telegram, and
          MT5. Charts are display-only — if the chart feed is down, alerts still arrive.
        </p>
      </div>
      <div className="setup-list">
        <div className="setup-step">
          <strong>1. Subscribe</strong>
          <p>Create an account, choose a plan, and complete payment.</p>
        </div>
        <div className="setup-step">
          <strong>2. Add your personal script</strong>
          <p>
            On the TradingView Setup tab, copy your personal script, paste it into TradingView&apos;s Pine Editor, and
            add it to any chart you trade (forex, metals, indices, crypto, stocks).
          </p>
        </div>
        <div className="setup-step">
          <strong>3. Create an alert</strong>
          <p>
            Create one alert for that script, turn on webhook notifications, and paste your Kaching webhook URL. One
            alert covers Entry, stop loss, and take-profit levels.
          </p>
        </div>
        <div className="setup-step">
          <strong>4. Receive everywhere you trade</strong>
          <p>
            When TradingView fires, Kaching publishes the trade to your dashboard, Telegram, and optional MT5
            execution.
          </p>
        </div>
      </div>
    </section>
  );
}
