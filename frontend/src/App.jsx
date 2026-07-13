import { useEffect, useState } from 'react';
import SignalDashboard from './components/SignalDashboard';
import Pricing from './components/Pricing';
import TradingViewDashboard from './components/TradingViewDashboard';
import AuthForm from './components/AuthForm';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import Hero from './components/Hero';
import RiskDisclosure from './components/RiskDisclosure';
import Contact from './components/Contact';
import { AuthProvider, useAuth } from './context/AuthContext';
import { fetchSignals } from './services/api';

function AppContent() {
  const { user, subscription, loading, logout, isAuthenticated, refreshSubscription } = useAuth();
  const [signals, setSignals] = useState([]);
  const [currentPage, setCurrentPage] = useState('home');
  const [previousPage, setPreviousPage] = useState('home');
  const [pageOptions, setPageOptions] = useState({});
  const [paymentNotice, setPaymentNotice] = useState('');

  const navigateTo = (page, options = {}) => {
    if (page === 'risk-disclosure') {
      setPreviousPage(currentPage);
    }
    setPageOptions(options);
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const closeRiskDisclosure = () => {
    navigateTo(previousPage);
  };

  const handleLogout = () => {
    logout();
    setCurrentPage('home');
  };

  useEffect(() => {
    if (!loading && isAuthenticated && currentPage === 'home') {
      setCurrentPage('dashboard');
    }
  }, [loading, isAuthenticated, currentPage]);

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchSignals()
      .then(setSignals)
      .catch(err => console.error('Error fetching signals:', err.message));
  }, [isAuthenticated]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paypalStatus = params.get('paypal');

    if (!paypalStatus) return;

    if (paypalStatus === 'success') {
      refreshSubscription().then(() => {
        setPaymentNotice('PayPal payment successful! Your subscription is now active.');
        setCurrentPage('pricing');
      });
    } else if (paypalStatus === 'cancelled') {
      setPaymentNotice('PayPal payment was cancelled.');
      setCurrentPage('pricing');
    } else if (paypalStatus === 'error') {
      setPaymentNotice(`PayPal payment failed: ${params.get('message') || 'Unknown error'}`);
      setCurrentPage('pricing');
    } else if (paypalStatus === 'mock') {
      setCurrentPage('pricing');
    }

    window.history.replaceState({}, '', window.location.pathname);
  }, [refreshSubscription]);

  if (loading) {
    return <LoadingShell />;
  }

  const navigateHome = () => {
    navigateTo(isAuthenticated ? 'dashboard' : 'home');
  };

  const renderPageContent = () => {
    if (currentPage === 'risk-disclosure') {
      return <RiskDisclosure onNavigateHome={navigateHome} onClose={closeRiskDisclosure} />;
    }

    if (currentPage === 'contact') {
      return <Contact onNavigateHome={navigateHome} />;
    }

    if (currentPage === 'home') {
      return (
        <Hero
          onViewPricing={() => setCurrentPage('pricing')}
          onSignUp={() => setCurrentPage('signup')}
        />
      );
    }

    if (currentPage === 'signin') {
      return (
        <AuthForm
          initialMode="login"
          onSuccess={() => setCurrentPage('dashboard')}
        />
      );
    }

    if (currentPage === 'signup') {
      return (
        <AuthForm
          initialMode="register"
          onSuccess={() => setCurrentPage('pricing')}
        />
      );
    }

    if (currentPage === 'dashboard') {
      return isAuthenticated ? (
        <SignalDashboard initialSignals={signals} subscription={subscription} />
      ) : (
        <AuthForm
          initialMode="login"
          onSuccess={() => setCurrentPage('dashboard')}
        />
      );
    }

    if (currentPage === 'tradingview') {
      return isAuthenticated ? (
        <TradingViewDashboard
          subscription={subscription}
          initialTab={pageOptions.tab}
          onNavigatePricing={() => navigateTo('pricing')}
        />
      ) : (
        <AuthForm
          initialMode="login"
          onSuccess={() => setCurrentPage('tradingview')}
        />
      );
    }

    return (
      <Pricing
        onSubscriptionUpdated={refreshSubscription}
        onNavigateDashboard={() => setCurrentPage('dashboard')}
        onSignIn={() => setCurrentPage('signin')}
      />
    );
  };

  return (
    <div className="site-layout">
      <Navbar
        isAuthenticated={isAuthenticated}
        user={user}
        subscription={subscription}
        currentPage={currentPage}
        onNavigate={navigateTo}
        onSignIn={() => navigateTo('signin')}
        onSignUp={() => navigateTo('signup')}
        onLogout={handleLogout}
      />

      <main className="site-main">
        {paymentNotice && (
          <div className="page-notice info-box">{paymentNotice}</div>
        )}

        {renderPageContent()}
      </main>

      <Footer
        onNavigate={navigateTo}
        onNavigateRiskDisclosure={() => navigateTo('risk-disclosure')}
      />
    </div>
  );
}

function LoadingShell() {
  return (
    <div className="site-layout">
      <main className="site-main">
        <div className="loading-state">Loading…</div>
      </main>
      <Footer onNavigate={() => {}} onNavigateRiskDisclosure={() => {}} />
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
