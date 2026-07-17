import { useEffect, useMemo, useState } from 'react';
import { scannerApi } from '../services/api';
import {
  DEFAULT_PREMIUM_SIGNAL_THRESHOLD,
  formatPremiumThresholdLabel,
  premiumSignalsScoredCopy
} from '../constants/scannerConfig';

const SHOWCASE_TEMPLATE = [
  {
    id: 'scan',
    image: '/images/ai-showcase-scan.png',
    eyebrow: 'Always-On Market Intelligence',
    title: 'Your AI never sleeps. Your edge never fades.',
    body:
      'While you focus on strategy and risk, KachingScanner AI watches dozens of markets around the clock—hunting liquidity sweeps, fair value gaps, and institutional footprints the moment they form. No manual chart scrolling. No missed setups. Just relentless, precision-driven opportunity detection.',
    highlights: ['Continuous multi-market surveillance', 'Institutional Smart Money Concepts engine'],
    reverse: false
  },
  {
    id: 'pipeline',
    image: '/images/ai-showcase-execution.png',
    eyebrow: '10-Step SMC Pipeline',
    title: 'Every signal earns its place.',
    body:
      'Unlike generic alert bots that fire on every gap, our AI runs a rigorous ten-step pipeline—liquidity pools, sweeps, market structure shifts, expansion candles, unmitigated FVGs, higher-timeframe bias, and retracement confirmation—before a premium signal is ever released.',
    highlights: [
      'Weighted quality scoring on every factor',
      'Higher-timeframe alignment built in',
      'Only high-conviction setups reach you'
    ],
    reverse: true
  },
  {
    id: 'explain',
    image: '/images/ai-showcase-intelligence.png',
    eyebrow: 'Explainable AI',
    title: 'Understand the why behind every trade.',
    body:
      'Great technology does not replace the trader—it elevates them. Each signal arrives with AI-generated explanations, confidence ratings, risk-to-reward breakdowns, and performance analytics so you trade with clarity, discipline, and continuous improvement.',
    highlights: [
      'Plain-language trade explanations',
      'Live confidence & pipeline scoring',
      'Journal, analytics, and win-rate tracking'
    ],
    reverse: false
  }
];

export default function AiIntelligenceSection({ onViewPricing, onSignUp }) {
  const [premiumThreshold, setPremiumThreshold] = useState(DEFAULT_PREMIUM_SIGNAL_THRESHOLD);

  useEffect(() => {
    scannerApi
      .getStatus()
      .then(res => {
        const threshold = Number(res.data?.pipeline?.premiumThreshold);
        if (Number.isFinite(threshold) && threshold > 0) {
          setPremiumThreshold(threshold);
        }
      })
      .catch(() => {});
  }, []);

  const thresholdLabel = formatPremiumThresholdLabel(premiumThreshold);

  const showcaseItems = useMemo(
    () =>
      SHOWCASE_TEMPLATE.map(item =>
        item.id === 'scan'
          ? {
              ...item,
              highlights: [
                ...item.highlights,
                premiumSignalsScoredCopy(premiumThreshold)
              ]
            }
          : item
      ),
    [premiumThreshold]
  );

  const stats = useMemo(
    () => [
      { value: '24/7', label: 'AI market scanning' },
      { value: '10', label: 'Step SMC validation pipeline' },
      { value: thresholdLabel, label: 'Premium signal threshold' },
      { value: '6', label: 'Weighted quality factors' }
    ],
    [thresholdLabel]
  );

  return (
    <section className="ai-intelligence-section" aria-labelledby="ai-intelligence-title">
      <div className="ai-intelligence-intro">
        <p className="ai-intelligence-eyebrow">Why traders choose KachingScanner AI</p>
        <h2 id="ai-intelligence-title" className="ai-intelligence-title">
          Intelligence that sees the market like institutions do
        </h2>
        <p className="ai-intelligence-lead">
          KachingScanner is not a signal spammer—it is an AI Trading Intelligence Platform engineered
          to think in sequences, score every setup, explain every decision, and help you execute with
          confidence. From first scan to final fill, the entire workflow is powered by purpose-built
          artificial intelligence.
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
              <img src={item.image} alt="" className="ai-showcase-image" loading="lazy" decoding="async" />
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
          &ldquo;The best trading AI does not shout the loudest—it proves its case, scores its
          conviction, and gives you the context to act with discipline.&rdquo;
        </blockquote>
        <p className="ai-intelligence-quote-caption">Built into every KachingScanner premium signal</p>
      </div>

      <div className="ai-intelligence-cta">
        <h3>Ready to trade with institutional-grade AI?</h3>
        <p>
          Join traders who let intelligent automation find the setup—while they focus on execution,
          risk, and results.
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
