import { CONTACT_EMAIL } from '../config/appUrls';

export default function RiskDisclosure({ onNavigateHome, onClose }) {
  const handleClose = onClose || onNavigateHome;

  return (
    <div className="risk-disclosure-page">
      <nav className="page-breadcrumb" aria-label="Breadcrumb">
        <button type="button" className="breadcrumb-link" onClick={onNavigateHome}>
          Home
        </button>
        <span className="breadcrumb-separator">/</span>
        <span className="breadcrumb-current">Risk Disclosure</span>
      </nav>

      <div className="risk-disclosure-card">
        <div className="risk-disclosure-header">
          <h1>Risk Disclosure</h1>
          <button
            type="button"
            className="risk-disclosure-close"
            onClick={handleClose}
            aria-label="Close risk disclosure"
          >
            ×
          </button>
        </div>

        <section>
          <h2>Trading Risk Notice</h2>
          <p>
            Trading in financial markets involves substantial risk and may not be suitable for all
            investors. AI-generated signals and automated strategies are analytical tools, not
            guarantees of profit. Always understand the risks involved and trade responsibly.
          </p>
          <p>
            Forex and leveraged products carry a high level of risk and may not be suitable for all
            investors. You may lose part or all of your capital.
          </p>
          <ul>
            <li>Past performance does not guarantee future results.</li>
            <li>Market volatility can move quickly against your position.</li>
            <li>You are responsible for your own trading decisions and risk limits.</li>
            <li>Only trade funds you can afford to lose.</li>
          </ul>
          <p>
            The educational content and analysis shared by KachingFxOfficial are for information
            purposes only and are not financial advice.
          </p>
        </section>

        <section>
          <h2>Contact Us</h2>
          <ul className="risk-contact-list">
            <li>
              Phone:{' '}
              <a href="tel:+254745522225">+254 745522225</a>
              {' / '}
              <a href="tel:+254737970108">+254 737970108</a>
            </li>
            <li>
              Email:{' '}
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </li>
            <li>
              WhatsApp:{' '}
              <a href="https://wa.me/254737970108" target="_blank" rel="noopener noreferrer">
                +254 737970108
              </a>
            </li>
          </ul>
        </section>

        <div className="risk-disclosure-actions">
          <button type="button" className="risk-disclosure-close-btn" onClick={handleClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
