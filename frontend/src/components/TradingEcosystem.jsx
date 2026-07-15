const ECOSYSTEM_CARDS = [
  {
    id: 'scanner',
    icon: 'bi-radar',
    accent: 'gold',
    title: 'AI Smart Scanner',
    hook: 'Never search the charts again.',
    description:
      'Our AI continuously scans dozens of markets using institutional Smart Money Concepts, Liquidity Sweeps, and Fair Value Gaps to identify high-probability trading opportunities before they become obvious.',
    features: [
      'Real-time market scanning',
      'Liquidity Sweep detection',
      'Fair Value Gap identification',
      'Order Block confirmation',
      'Multi-timeframe analysis',
      'AI Confidence Score',
      'Live multi-timeframe charts',
      'Real-time candle streaming',
      'Entry, SL & TP overlays on-chart'
    ]
  },
  {
    id: 'execution',
    icon: 'bi-lightning-charge',
    accent: 'emerald',
    title: 'Professional Trade Execution',
    hook: 'From signal to execution in seconds.',
    description: [
      'Receive instant alerts directly inside TradingView, Telegram, or execute trades automatically on MetaTrader 5 with our One-Click Trade Copier.',
      'Spend less time placing trades and more time managing risk.'
    ],
    features: [
      'TradingView alerts',
      'One-click MT5 execution',
      'Telegram notifications',
      'Automatic Stop Loss & Take Profit',
      'Risk-based position sizing',
      'Break-even & trade management'
    ]
  },
  {
    id: 'intelligence',
    icon: 'bi-stars',
    accent: 'navy',
    title: 'AI Trading Intelligence',
    hook: 'Know why every trade exists.',
    description: [
      'Every signal includes a complete AI explanation, confidence rating, risk analysis, reward projections, and detailed performance tracking so you learn while you trade.',
      "This isn't just another signal service—it's an intelligent trading assistant."
    ],
    features: [
      'AI trade explanations',
      'Risk-to-reward analysis',
      'Signal history',
      'Win-rate analytics',
      'Trading journal',
      'Performance dashboard'
    ]
  }
];

export default function TradingEcosystem() {
  return (
    <section className="trading-ecosystem-section" aria-labelledby="trading-ecosystem-title">
      <div className="trading-ecosystem-header">
        <h2 id="trading-ecosystem-title" className="trading-ecosystem-title">
          AI-Powered Trading Ecosystem!
        </h2>
        <p className="trading-ecosystem-subtitle">
          Scan, analyze, and execute from one intelligent platform built for serious traders.
        </p>
      </div>

      <div className="trading-ecosystem-grid">
        {ECOSYSTEM_CARDS.map(card => (
          <article
            key={card.id}
            className={`ecosystem-card ecosystem-card-${card.accent}`}
          >
            <div className="ecosystem-card-icon-wrap" aria-hidden="true">
              <i className={`bi ${card.icon} ecosystem-card-icon`} />
            </div>
            <h3 className="ecosystem-card-title">{card.title}</h3>
            <p className="ecosystem-card-hook">{card.hook}</p>
            <p className="ecosystem-card-description">
              {Array.isArray(card.description) ? card.description.join(' ') : card.description}
            </p>
            <ul className="ecosystem-card-features">
              {card.features.map(feature => (
                <li key={feature}>
                  <span className="ecosystem-check" aria-hidden="true">
                    ✔
                  </span>
                  <span className="ecosystem-feature-text">{feature}</span>
                </li>
              ))}
            </ul>
            <div className="ecosystem-card-spacer" aria-hidden="true" />
          </article>
        ))}
      </div>
    </section>
  );
}
