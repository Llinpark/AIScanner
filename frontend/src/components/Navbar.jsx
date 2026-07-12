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
  const pageLinks = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'tradingview', label: 'TradingView Setup' },
    { id: 'pricing', label: 'Pricing' },
    { id: 'contact', label: 'Contact' }
  ];

  return (
    <header className="site-navbar">
      <div className="navbar-inner">
        <button
          type="button"
          className="navbar-brand"
          onClick={() => onNavigate(isAuthenticated ? 'dashboard' : 'home')}
          aria-label="KachingFx AI Scanner home"
        >
          <img className="navbar-logo" src="/logo-1.png" alt="KachingFx AI Scanner" />
        </button>

        <nav className="navbar-links" aria-label="Main navigation">
          {pageLinks.map(link => (
            <button
              key={link.id}
              type="button"
              className={`navbar-link ${currentPage === link.id ? 'active' : ''}`}
              onClick={() => onNavigate(link.id)}
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
    </header>
  );
}
