import { useEffect, useState } from 'react';
import AppLink from './AppLink';
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
    ...(isAuthenticated ? [{ id: 'referrals', label: 'Refer & Earn' }] : []),
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

  const handleNavigate = (page, options, navOpts) => {
    setMenuOpen(false);
    onNavigate(page, options, navOpts);
  };

  return (
    <header className={`site-navbar ${menuOpen ? 'menu-open' : ''}`}>
      <div className="navbar-inner">
        <AppLink
          page="home"
          onNavigate={handleNavigate}
          className="navbar-brand"
          ariaLabel={`${APP_NAME} home`}
        >
          <img className="navbar-logo" src="/logo-1.png" alt={APP_NAME} width="140" height="40" />
        </AppLink>

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
              <AppLink
                key={link.id}
                page={link.id}
                onNavigate={handleNavigate}
                className={`navbar-link ${currentPage === link.id ? 'active' : ''}`}
                ariaCurrent={currentPage === link.id ? 'page' : undefined}
              >
                {link.label}
              </AppLink>
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
                <AppLink
                  page="signup"
                  onNavigate={() => {
                    setMenuOpen(false);
                    onSignUp();
                  }}
                  className={`navbar-auth-link ${currentPage === 'signup' ? 'active' : ''}`}
                  ariaCurrent={currentPage === 'signup' ? 'page' : undefined}
                >
                  Register
                </AppLink>
                <AppLink
                  page="signin"
                  onNavigate={() => {
                    setMenuOpen(false);
                    onSignIn();
                  }}
                  className={`navbar-auth-link navbar-auth-link-primary ${currentPage === 'signin' ? 'active' : ''}`}
                  ariaCurrent={currentPage === 'signin' ? 'page' : undefined}
                >
                  Login
                </AppLink>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
