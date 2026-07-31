export default function TradingViewSetup() {
  return (
    <section className="tradingview-setup">
      <div className="setup-header">
        <h2>How setup works</h2>
        <p>
          Connect TradingView to Kaching so alerts from any chart instrument appear on the dashboard, Telegram, and
          MT5. Charts are display-only — if the chart feed is down, alerts still arrive.
        </p>
      </div>
      <ol className="setup-list">
        <li className="setup-step">
          <strong>Subscribe</strong>
          <p>Create an account, choose a plan, and complete payment.</p>
        </li>
        <li className="setup-step">
          <strong>Link your TradingView username</strong>
          <p>
            Enter the exact TradingView username you will run the script under. Your personal script is licensed to
            that account.
          </p>
        </li>
        <li className="setup-step">
          <strong>Add your personal script</strong>
          <p>
            Copy your script, paste it into TradingView&apos;s Pine Editor, and add it to any chart you trade. Leave
            Confirm username prefilled so the script unlocks on paste.
          </p>
        </li>
        <li className="setup-step">
          <strong>Create an alert</strong>
          <p>
            Create one alert for that script, turn on webhook notifications, and paste your Kaching webhook URL. One
            alert covers Entry, stop loss, and take-profit levels.
          </p>
        </li>
        <li className="setup-step">
          <strong>Receive everywhere</strong>
          <p>
            When TradingView fires, Entry / SL / TP overlays appear on that chart, and Kaching publishes the trade to
            your dashboard (plus Telegram / MT5 on higher plans).
          </p>
        </li>
      </ol>
    </section>
  );
}
