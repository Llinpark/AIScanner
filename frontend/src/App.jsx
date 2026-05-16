import { useEffect, useState } from 'react';
import SignalDashboard from './components/SignalDashboard';
import Pricing from './components/Pricing';
import TradingViewDashboard from './components/TradingViewDashboard';
import { fetchSignals, subscriptionApi } from './services/api';

function App() {
  const [signals, setSignals] = useState([]);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState('dashboard'); // 'dashboard', 'pricing', 'tradingview'
  const [currentUser, setCurrentUser] = useState(null);
  const [subscription, setSubscription] = useState(null);
  const [username, setUsername] = useState(localStorage.getItem('username') || '');

  useEffect(() => {
    fetchSignals()
      .then(setSignals)
      .catch(err => console.error('Error fetching signals:', err.message));
  }, []);

  const handleLogin = (user) => {
    setUsername(user);
    setCurrentUser(user);
    localStorage.setItem('username', user);
    fetchSubscription(user);
    setCurrentPage('dashboard');
  };

  const fetchSubscription = async (user) => {
    try {
      const response = await subscriptionApi.getSubscription(user);
      setSubscription(response.data.subscription);
    } catch (err) {
      console.error('Error fetching subscription:', err.message);
    }
  };

  useEffect(() => {
    if (username) {
      fetchSubscription(username);
    }
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-branding">
          <img className="app-logo" src="/logo-1.png" alt="KachingFx AI Scanner logo" />
          <div>
            <h1>KachingFx AI Scanner</h1>
            <p>Structural FVG &amp; Breakaway Gap scanner with live entry, stop loss, and take profit alerts.</p>
          </div>
        </div>
        <nav className="app-nav">
          <button
            className={`nav-btn ${currentPage === 'dashboard' ? 'active' : ''}`}
            onClick={() => setCurrentPage('dashboard')}
          >
            Dashboard
          </button>
          <button
            className={`nav-btn ${currentPage === 'tradingview' ? 'active' : ''}`}
            onClick={() => setCurrentPage('tradingview')}
          >
            TradingView
          </button>
          <button
            className={`nav-btn ${currentPage === 'pricing' ? 'active' : ''}`}
            onClick={() => setCurrentPage('pricing')}
          >
            Pricing
          </button>
          {currentUser && (
            <div className="user-info">
              <span>👤 {currentUser}</span>
              {subscription && (
                <span className={`tier-badge tier-${subscription.tier}`}>
                  {subscription.tier.toUpperCase()} ({subscription.status})
                </span>
              )}
            </div>
          )}
        </nav>
      </header>
      {error && <div className="app-error">{error}</div>}

      {currentPage === 'dashboard' ? (
        !currentUser ? (
          <div className="login-container">
            <div className="login-card">
              <h2>Welcome to KachingFx AI Scanner</h2>
              <p>Enter your username to access the dashboard</p>
              <input
                type="text"
                placeholder="Enter username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleLogin(username)}
              />
              <button onClick={() => handleLogin(username)}>Login</button>
            </div>
          </div>
        ) : (
          <SignalDashboard initialSignals={signals} username={currentUser} subscription={subscription} />
        )
      ) : currentPage === 'tradingview' ? (
        !currentUser ? (
          <div className="login-container">
            <div className="login-card">
              <h2>Please Login First</h2>
              <p>You need to log in to access TradingView integration</p>
            </div>
          </div>
        ) : (
          <TradingViewDashboard
            username={currentUser}
            subscription={subscription}
            onNavigatePricing={() => setCurrentPage('pricing')}
          />
        )
      ) : (
        <Pricing />
      )}
    </div>
  );
}

export default App;
