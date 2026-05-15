export default function TradingViewSetup() {
  return (
    <section className="tradingview-setup">
      <div className="setup-header">
        <h2>TradingView Setup Guide</h2>
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
        </div>
      </div>
    </section>
  );
}
