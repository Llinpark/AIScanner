export default function TradingViewSetup() {
  return (
    <section className="tradingview-setup">
      <div className="setup-header">
        <h2>TradingView Setup Guide</h2>
<<<<<<< HEAD
        <p>
          After subscribing, open TradingView to receive Entry, Stop Loss, and Take Profit 1, 2, and 3 alerts.
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
          <p>Set up TradingView alerts for Entry, Stop Loss, TP1, TP2, and TP3 with webhook notifications enabled.</p>
        </div>
        <div className="setup-step">
          <strong>4. Enable TradingView notifications</strong>
          <p>Turn on push or email notifications in TradingView so alerts reach you in real time.</p>
=======
        <p>Use this guide to publish your Pine Script strategy and route alerts directly into KachingScanner.</p>
      </div>
      <div className="setup-list">
        <div className="setup-step">
          <strong>1. Publish or save a Pine Script</strong>
          <p>Open TradingView, create a new script, paste the sample Pine code from <code>backend/tradingview-pine-script.pine</code>, and save it as a private or published script.</p>
        </div>
        <div className="setup-step">
          <strong>2. Apply the script to a chart</strong>
          <p>Add the saved script to the chart for the symbol you want to receive alerts on.</p>
        </div>
        <div className="setup-step">
          <strong>3. Create a webhook alert</strong>
          <p>In TradingView, create an alert from the script and choose “Webhook URL”. Then set the webhook target to:</p>
          <code>http://localhost:4000/api/webhook/tradingview</code>
        </div>
        <div className="setup-step">
          <strong>4. Set your secret</strong>
          <p>Use the same `TRADINGVIEW_WEBHOOK_SECRET` value stored in your backend environment and include it in the alert payload.</p>
        </div>
        <div className="setup-step">
          <strong>5. Test your alert</strong>
          <p>Trigger the alert from TradingView and verify that KachingScanner receives the signal. The backend will save it and broadcast it to the dashboard.</p>
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
        </div>
      </div>
    </section>
  );
}
