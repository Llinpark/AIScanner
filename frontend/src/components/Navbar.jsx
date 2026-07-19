import { useEffect, useState } from 'react';

import { APP_NAME } from '../config/appUrls';

const TIER_BADGE_LABELS = { basic: 'BASIC', professional: 'PRO', premium: 'PREMIUM' };

export default function Navbar({
  isAuthenticated,
  user,
  subscription,
  currentPage,
  onNavigate,
  onSignIn,
  onSignUp,
  onLogout
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  const pageLinks = [
    { id: 'home', label: 'Home' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'insights', label: 'Insights' },
    { id: 'tradingview', label: 'TradingView Setup' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'referrals', label: 'Refer & Earn' },
    { id: 'contact', label: 'Contact' },
    ...(user?.isAdmin ? [{ id: 'admin', label: 'Admin' }] : [])
  ];

  useEffect(() => {
    setMenuOpen(false);
  }, [currentPage]);

  useEffect(() => {
    document.body.classList.toggle('nav-menu-open', menuOpen);
    return () => document.body.classList.remove('nav-menu-open');
  }, [menuOpen]);

  const handleNavigate = page => {
    setMenuOpen(false);
    onNavigate(page);
  };

  return (
    <header className={`site-navbar ${menuOpen ? 'menu-open' : ''}`}>
      <div className="navbar-inner">
        <button
          type="button"
          className="navbar-brand"
          onClick={() => handleNavigate('home')}
          aria-label={`${APP_NAME} home`}
        >
          <img className="navbar-logo" src="/logo-1.png" alt={APP_NAME} />
        </button>

        <button
          type="button"
          className="navbar-menu-toggle"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls="navbar-panel"
          onClick={() => setMenuOpen(open => !open)}
        >
          <span className="navbar-menu-icon" aria-hidden="true" />
        </button>

        <div id="navbar-panel" className={`navbar-panel ${menuOpen ? 'open' : ''}`}>
          <nav className="navbar-links" aria-label="Main navigation">
            {pageLinks.map(link => (
              <button
                key={link.id}
                type="button"
                className={`navbar-link ${currentPage === link.id ? 'active' : ''}`}
                onClick={() => handleNavigate(link.id)}
              >
                {link.label}
              </button>
            ))}
          </nav>

          <div className="navbar-auth">
            {isAuthenticated ? (
              <>
                <div className="navbar-user">
                  <span className="navbar-user-name">{user.displayName || user.email}</span>
                  {subscription && (
                    <span className={`tier-badge tier-${subscription.tier}`}>
                      {TIER_BADGE_LABELS[subscription.tier] || subscription.tier.toUpperCase()}
                    </span>
                  )}
                </div>
                <button type="button" className="navbar-auth-link" onClick={onLogout}>
                  Log Out
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={`navbar-auth-link ${currentPage === 'signup' ? 'active' : ''}`}
                  onClick={onSignUp}
                >
                  Register
                </button>
                <button
                  type="button"
                  className={`navbar-auth-link navbar-auth-link-primary ${currentPage === 'signin' ? 'active' : ''}`}
                  onClick={onSignIn}
                >
                  Login
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
