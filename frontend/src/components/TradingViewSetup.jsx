export default function TradingViewSetup() {
  return (
    <section className="tradingview-setup">
      <div className="setup-header">
        <h2>TradingView Setup Guide</h2>
        <p>
          After subscribing, open TradingView to receive Kaching Entry, Kaching Stop Loss, and Kaching Take Profit alerts.
          No username linking is required in the app.
        </p>
      </div>
      <div className="setup-list">
        <div className="setup-step">
          <strong>1. Subscribe in KachingFx</strong>
          <p>Create an account, choose a plan, and complete payment.</p>
        </div>
        <div className="setup-step">
          <strong>2. Add the Pine Script to TradingView</strong>
          <p>Copy the KachingFx Structural Scanner script from the TradingView Setup page and add it to your chart.</p>
        </div>
        <div className="setup-step">
          <strong>3. Create alerts for each level</strong>
          <p>Set up TradingView alerts for Kaching Entry, Kaching Stop Loss, Kaching Take Profit 1, Kaching Take Profit 2, and Kaching Take Profit 3 with webhook notifications enabled.</p>
        </div>
        <div className="setup-step">
          <strong>4. Enable TradingView notifications</strong>
          <p>Turn on push or email notifications in TradingView so alerts reach you in real time.</p>
        </div>
      </div>
    </section>
  );
}
