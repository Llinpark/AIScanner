import { useEffect, useState } from 'react';
import AppLink from './AppLink';
import SocialLinks from './SocialLinks';
import { APP_NAME, APP_TAGLINE, CONTACT_EMAIL, SITE_URL } from '../config/appUrls';

const RISK_DISMISSED_KEY = 'kachingfx_risk_bar_dismissed';

export default function Footer({ onNavigate, onNavigateRiskDisclosure }) {
  const [barDismissed, setBarDismissed] = useState(false);

  useEffect(() => {
    localStorage.removeItem(RISK_DISMISSED_KEY);
  }, []);

  const dismissBar = () => {
    setBarDismissed(true);
  };

  const goTo = (page, options) => {
    if (onNavigate) {
      onNavigate(page, options);
    }
  };

  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-brand">
          <p>{APP_TAGLINE}</p>
          <div className="footer-contact">
            <p>
              <strong>Phone:</strong>{' '}
              <a href="tel:+254745522225">+254 745522225</a>
              {' / '}
              <a href="tel:+254737970108">+254 737970108</a>
            </p>
            <p>
              <strong>Email:</strong>{' '}
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </p>
          </div>
        </div>

        <div className="footer-links">
          <h4>Product</h4>
          <ul>
            <li>
              <AppLink page="dashboard" onNavigate={goTo} className="footer-link">
                Live signal dashboard
              </AppLink>
            </li>
            <li>
              <AppLink
                page="tradingview"
                options={{ tab: 'live' }}
                onNavigate={goTo}
                className="footer-link"
              >
                TradingView alerts
              </AppLink>
            </li>
            <li>
              <AppLink page="pricing" onNavigate={goTo} className="footer-link">
                Subscription plans
              </AppLink>
            </li>
            <li>
              <AppLink page="referrals" onNavigate={goTo} className="footer-link">
                Refer &amp; Earn
              </AppLink>
            </li>
          </ul>
        </div>

        <div className="footer-links">
          <h4>Support</h4>
          <ul>
            <li>
              <AppLink
                page="tradingview"
                options={{ tab: 'setup' }}
                onNavigate={goTo}
                className="footer-link"
              >
                TradingView setup guide
              </AppLink>
            </li>
            <li>
              <AppLink page="pricing" onNavigate={goTo} className="footer-link">
                Subscription &amp; payments
              </AppLink>
            </li>
            <li>
              <AppLink page="contact" onNavigate={goTo} className="footer-link">
                Contact us
              </AppLink>
            </li>
          </ul>
        </div>

        <div className="footer-follow">
          <h4>Follow Us</h4>
          <p>Stay connected for updates, market commentary, and trade alerts.</p>
          <SocialLinks />
        </div>
      </div>

      <div className="footer-bottom">
        <p>
          &copy; {new Date().getFullYear()}{' '}
          <a href={SITE_URL} target="_blank" rel="noopener noreferrer">
            {APP_NAME}
          </a>
          . All Rights Reserved
        </p>
      </div>

      {!barDismissed && <div className="footer-risk-spacer" aria-hidden="true" />}

      {!barDismissed && (
        <div className="footer-risk">
          <div className="footer-risk-bar">
            <p className="footer-risk-text">
              Risk Warning: Your capital is at risk. Leveraged products may not be suitable for
              everyone. Please consider our{' '}
              <AppLink
                page="risk-disclosure"
                onNavigate={() => onNavigateRiskDisclosure?.()}
                className="footer-risk-link"
              >
                Risk Disclosure
              </AppLink>
              .
            </p>
            <button
              type="button"
              className="footer-risk-close"
              onClick={dismissBar}
              aria-label="Dismiss risk warning"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </footer>
  );
}
