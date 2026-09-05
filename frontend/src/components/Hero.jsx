export default function Hero({ onViewPricing, onSignUp, onReferEarn }) {
  return (
    <section className="hero-section">
      <div className="hero-glow hero-glow-left" aria-hidden="true" />
      <div className="hero-glow hero-glow-right" aria-hidden="true" />

      <div className="hero-inner">
        <div className="hero-content">
          <p className="hero-eyebrow">AI-Powered Forex Intelligence</p>
          <h1 className="hero-title">From Market Analysis to Trade Execution</h1>
          <p className="hero-description">
            Powerful AI that monitors the market, detects trading opportunities, and delivers precise
            Entry, Stop Loss, and Take Profit levels—or automatically executes your strategy based on
            your preferences.
          </p>

          <div className="hero-actions">
            <button type="button" className="hero-btn hero-btn-primary" onClick={onViewPricing}>
              View Plans
            </button>
            <button type="button" className="hero-btn hero-btn-secondary" onClick={onSignUp}>
              Get Started
            </button>
            {onReferEarn && (
              <button type="button" className="hero-btn hero-btn-tertiary" onClick={onReferEarn}>
                Refer &amp; Earn
              </button>
            )}
          </div>
        </div>

        <div className="hero-media">
          <div className="hero-image-wrap">
            <img
              src="/hero-img.png"
              alt="KachingScanner AI trading dashboard on tablet and mobile"
              className="hero-image"
              width="960"
              height="720"
              loading="eager"
              decoding="async"
              fetchPriority="high"
            />
            <div className="hero-image-fade" aria-hidden="true" />
          </div>
        </div>
      </div>
    </section>
  );
}
