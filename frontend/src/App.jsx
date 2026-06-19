import { useEffect, useState } from 'react';
import SignalDashboard from './components/SignalDashboard';
import Pricing from './components/Pricing';
import TradingViewDashboard from './components/TradingViewDashboard';
import AuthForm from './components/AuthForm';
import { AuthProvider, useAuth } from './context/AuthContext';
import { fetchSignals } from './services/api';

const TIER_BADGE_LABELS = { basic: 'BASIC', professional: 'PRO', premium: 'PREMIUM' };

function AppContent() {
  const { user, subscription, loading, logout, isAuthenticated, refreshSubscription } = useAuth();
  const [signals, setSignals] = useState([]);
  const [currentPage, setCurrentPage] = useState('dashboard');

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchSignals()
      .then(setSignals)
      .catch(err => console.error('Error fetching signals:', err.message));
  }, [isAuthenticated]);

  if (loading) {
    return (
      <div className="app-shell">
        <div className="loading-state">Loading…</div>
      </div>
    );
  }

  const needsAuth = !isAuthenticated && currentPage !== 'pricing';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-branding">
          <img className="app-logo" src="/logo-1.png" alt="KachingFx AI Scanner logo" />
          <div>
            <h1>KachingFx AI Scanner</h1>
            <p>
              Subscribe for live trading signals. Open TradingView for accurate Entry, Stop Loss, and Take Profit alerts.
            </p>
          </div>
        </div>
        <nav className="app-nav">
          <button
            type="button"
            className={`nav-btn ${currentPage === 'dashboard' ? 'active' : ''}`}
            onClick={() => setCurrentPage('dashboard')}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={`nav-btn ${currentPage === 'tradingview' ? 'active' : ''}`}
            onClick={() => setCurrentPage('tradingview')}
          >
            TradingView Setup
          </button>
          <button
            type="button"
            className={`nav-btn ${currentPage === 'pricing' ? 'active' : ''}`}
            onClick={() => setCurrentPage('pricing')}
          >
            Pricing
          </button>
          {isAuthenticated && (
            <div className="user-info">
              <span>{user.displayName || user.email}</span>
              {subscription && (
                <span className={`tier-badge tier-${subscription.tier}`}>
                  {TIER_BADGE_LABELS[subscription.tier] || subscription.tier.toUpperCase()} ({subscription.status})
                </span>
              )}
              <button type="button" className="btn-logout" onClick={logout}>
                Sign out
              </button>
            </div>
          )}
        </nav>
      </header>

      {needsAuth ? (
        <AuthForm onSuccess={() => setCurrentPage('pricing')} />
      ) : currentPage === 'dashboard' ? (
        isAuthenticated ? (
          <SignalDashboard initialSignals={signals} subscription={subscription} />
        ) : (
          <AuthForm onSuccess={() => setCurrentPage('dashboard')} />
        )
      ) : currentPage === 'tradingview' ? (
        isAuthenticated ? (
          <TradingViewDashboard subscription={subscription} onNavigatePricing={() => setCurrentPage('pricing')} />
        ) : (
          <AuthForm onSuccess={() => setCurrentPage('tradingview')} />
        )
      ) : (
        <Pricing onSubscriptionUpdated={refreshSubscription} onNavigateDashboard={() => setCurrentPage('dashboard')} />
      )}
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

export default App;
