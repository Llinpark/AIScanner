export default function TradingViewSetup() {
  return (
    <section className="tradingview-setup">
      <div className="setup-header">
        <h2>TradingView Setup Guide</h2>
        <p>
          After subscribing, add the KachingFx Structural Scanner to TradingView once. Entry, SL, and TP1–TP3
          lines are drawn automatically on your chart when a pattern fires — no manual level placement.
        </p>
      </div>
      <div className="setup-list">
        <div className="setup-step">
          <strong>1. Subscribe in KachingFx</strong>
          <p>Create an account, choose a plan, and complete payment.</p>
        </div>
        <div className="setup-step">
          <strong>2. Add the Pine Script to TradingView</strong>
          <p>
            Copy your personal KachingFx Structural Scanner script from the TradingView tab and add it to your
            chart. Keep &quot;Auto-draw Entry / SL / TP lines on chart&quot; enabled in the indicator settings.
          </p>
        </div>
        <div className="setup-step">
          <strong>3. Create one webhook alert</strong>
          <p>
            In TradingView, create a single alert with condition &quot;Any alert() function call&quot;, enable
            webhook notifications, and paste the webhook URL from the script inputs. This sends live signals to
            KachingFx automatically — you do not need separate alerts for Entry, SL, or each TP.
          </p>
        </div>
        <div className="setup-step">
          <strong>4. Enable TradingView notifications</strong>
          <p>Turn on push or email notifications in TradingView so alerts reach you in real time.</p>
        </div>
      </div>
    </section>
  );
}
