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
          <strong>2. Link your TradingView username</strong>
          <p>
            On the TradingView Setup tab, enter the exact TradingView username you will run the script under. Your
            personal script is licensed to that account and will not send valid alerts from another TradingView login.
          </p>
        </div>
        <div className="setup-step">
          <strong>3. Add your personal script</strong>
          <p>
            Copy your personal script, paste it into TradingView&apos;s Pine Editor, and add it to any chart you trade.
            In script settings, confirm the same TradingView username to unlock signals. Leave it on the chart so Entry,
            SL, and TP1–3 overlays draw when signals fire (Basic and up).
          </p>
        </div>
        <div className="setup-step">
          <strong>4. Create an alert</strong>
          <p>
            Create one alert for that script, turn on webhook notifications, and paste your Kaching webhook URL. One
            alert covers Entry, stop loss, and take-profit levels.
          </p>
        </div>
        <div className="setup-step">
          <strong>5. Receive everywhere you trade</strong>
          <p>
            When TradingView fires, you see Entry / SL / TP overlays on that chart, and Kaching publishes the trade to
            your dashboard (plus Telegram / MT5 on higher plans).
          </p>
        </div>
      </div>
    </section>
  );
}
