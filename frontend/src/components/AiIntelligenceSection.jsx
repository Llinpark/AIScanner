import { useMemo } from 'react';

const SHOWCASE_TEMPLATE = [
  {
    id: 'scan',
    image: '/images/ai-showcase-scan.png',
    eyebrow: 'TradingView → Kaching distribution',
    title: 'Your strategy fires. We deliver everywhere.',
    body:
      'Attach your personal Pine script to any TradingView chart—forex, metals, indices, crypto, or stocks. When the alert fires, Kaching publishes Entry, stop loss, and take-profit levels to your dashboard, Telegram, and optional MT5 execution.',
    highlights: [
      'Works on any TradingView instrument',
      'Dashboard, Telegram, and MT5 in one flow',
      'Charts are display-only and never block alerts'
    ],
    reverse: false
  },
  {
    id: 'distribute',
    image: '/images/ai-showcase-execution.png',
    eyebrow: 'One alert, every destination',
    title: 'Levels you trust, delivered instantly.',
    body:
      'TradingView remains the source of truth for the trade idea. Kaching does not re-run a backend signal pipeline—it normalizes the webhook, stores the levels, and fans them out to the tools you already use to trade.',
    highlights: [
      'Webhook ingest for any chart symbol',
      'Personal license-bound Pine script',
      'Optional MT5 trade copier with broker suffix mapping'
    ],
    reverse: true
  },
  {
    id: 'explain',
    image: '/images/ai-showcase-intelligence.png',
    eyebrow: 'Clarity after the alert',
    title: 'Context, risk, and journal in one place.',
    body:
      'Each distributed alert can include strategy name, timeframe, confidence, risk metrics, and commentary—so you can review, journal, and execute without reconstructing the setup from scratch.',
    highlights: [
      'Strategy metadata from your Pine alert',
      'Risk analysis and trade journal (Pro+)',
      'Performance insights from your TradingView history'
    ],
    reverse: false
  }
];

export default function AiIntelligenceSection({ onViewPricing, onSignUp }) {
  const showcaseItems = useMemo(() => SHOWCASE_TEMPLATE, []);

  const stats = useMemo(
    () => [
      { value: 'TV', label: 'TradingView as signal source' },
      { value: 'Any', label: 'Instrument your chart uses' },
      { value: '3', label: 'Destinations: app · Telegram · MT5' },
      { value: '0', label: 'Backend pipeline regenerations' }
    ],
    []
  );

  return (
    <section className="ai-intelligence-section" aria-labelledby="ai-intelligence-title">
      <div className="ai-intelligence-intro">
        <p className="ai-intelligence-eyebrow">Why traders choose KachingScanner</p>
        <h2 id="ai-intelligence-title" className="ai-intelligence-title">
          TradingView alerts, delivered where you trade
        </h2>
        <p className="ai-intelligence-lead">
          Kaching is the distribution layer for your Pine strategy—not a second signal engine fighting
          your chart. Alerts arrive with Entry, SL, and TP levels from TradingView and publish to your
          dashboard, Telegram, and MT5.
        </p>
      </div>

      <div className="ai-intelligence-stats" aria-label="Platform highlights">
        {stats.map(stat => (
          <div key={stat.label} className="ai-stat-card">
            <strong className="ai-stat-value">{stat.value}</strong>
            <span className="ai-stat-label">{stat.label}</span>
          </div>
        ))}
      </div>

      <div className="ai-showcase-list">
        {showcaseItems.map(item => (
          <article
            key={item.id}
            className={`ai-showcase-panel${item.reverse ? ' ai-showcase-panel-reverse' : ''}`}
          >
            <div className="ai-showcase-media">
              <img
                src={item.image}
                alt={item.title}
                className="ai-showcase-image"
                width="640"
                height="420"
                loading="lazy"
                decoding="async"
              />
              <div className="ai-showcase-media-glow" aria-hidden="true" />
            </div>
            <div className="ai-showcase-copy">
              <p className="ai-showcase-eyebrow">{item.eyebrow}</p>
              <h3 className="ai-showcase-title">{item.title}</h3>
              <p className="ai-showcase-body">{item.body}</p>
              <ul className="ai-showcase-highlights">
                {item.highlights.map(point => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </div>

      <div className="ai-intelligence-quote">
        <blockquote>
          &ldquo;The best trading stack does not reinvent your chart—it delivers your alert levels to
          every place you execute.&rdquo;
        </blockquote>
        <p className="ai-intelligence-quote-caption">Built into every KachingScanner TradingView alert</p>
      </div>

      <div className="ai-intelligence-cta">
        <h3>Ready to distribute your TradingView alerts?</h3>
        <p>
          Connect Pine once, then receive Entry, SL, and TP on your dashboard, Telegram, and optional
          MT5 copier—on any instrument you chart.
        </p>
        <div className="ai-intelligence-actions">
          <button type="button" className="hero-btn hero-btn-primary" onClick={onViewPricing}>
            View Plans
          </button>
          <button type="button" className="hero-btn hero-btn-secondary" onClick={onSignUp}>
            Get Started Free
          </button>
        </div>
      </div>
    </section>
  );
}
