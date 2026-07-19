import { useEffect, useState } from 'react';
import SignalDashboard from './components/SignalDashboard';
import Pricing from './components/Pricing';
import TradingViewDashboard from './components/TradingViewDashboard';
import AuthForm from './components/AuthForm';
import ResetPasswordForm from './components/ResetPasswordForm';
import VerifyEmailPage from './components/VerifyEmailPage';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import AcceptedPayments from './components/AcceptedPayments';
import Hero from './components/Hero';
import TradingEcosystem from './components/TradingEcosystem';
import AiIntelligenceSection from './components/AiIntelligenceSection';
import RiskDisclosure from './components/RiskDisclosure';
import Contact from './components/Contact';
import InsightsHub from './components/InsightsHub';
import ReferAndEarn from './components/ReferAndEarn';
import AdminHub from './admin/AdminHub';
import { AuthProvider, useAuth } from './context/AuthContext';
import { fetchSignals } from './services/api';
import { APP_DESCRIPTION, APP_PAGE_TITLE } from './config/appUrls';
import { storeReferralCode } from './utils/referralStorage';

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
    document.title = APP_PAGE_TITLE;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) {
      meta.setAttribute('content', APP_DESCRIPTION);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    fetchSignals()
      .then(setSignals)
      .catch(err => console.error('Error fetching signals:', err.message));
  }, [isAuthenticated]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verifyToken = params.get('verify');
    const resetToken = params.get('reset');
    const refCode = params.get('ref');
    const paypalStatus = params.get('paypal');
    const binanceStatus = params.get('binance');

    if (refCode) {
      storeReferralCode(refCode);
      if (!verifyToken && !resetToken && !paypalStatus && !binanceStatus) {
        setCurrentPage('signup');
      }
      window.history.replaceState({}, '', window.location.pathname);
    }

    if (verifyToken) {
      setCurrentPage('verify-email');
      setPageOptions({ token: verifyToken });
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    if (resetToken) {
      setCurrentPage('reset-password');
      setPageOptions({ token: resetToken });
      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

    if (binanceStatus) {
      if (binanceStatus === 'success') {
        refreshSubscription().then(() => {
          setPaymentNotice('Binance Pay payment successful! Your subscription is now active.');
          setCurrentPage('pricing');
        });
      } else if (binanceStatus === 'cancelled') {
        setPaymentNotice('Binance Pay payment was cancelled.');
        setCurrentPage('pricing');
      } else if (binanceStatus === 'pending') {
        setPaymentNotice('Binance Pay payment is still processing. We will activate your subscription once it confirms.');
        setCurrentPage('pricing');
      } else if (binanceStatus === 'mock') {
        setCurrentPage('pricing');
      } else if (binanceStatus === 'error') {
        setPaymentNotice(`Binance Pay payment failed: ${params.get('message') || 'Unknown error'}`);
        setCurrentPage('pricing');
      }

      window.history.replaceState({}, '', window.location.pathname);
      return;
    }

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
    navigateTo('home');
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
        <>
          <Hero
            onViewPricing={() => setCurrentPage('pricing')}
            onSignUp={() => setCurrentPage('signup')}
          />
          <TradingEcosystem />
          <AiIntelligenceSection
            onViewPricing={() => setCurrentPage('pricing')}
            onSignUp={() => setCurrentPage('signup')}
          />
        </>
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

    if (currentPage === 'verify-email') {
      return (
        <VerifyEmailPage
          token={pageOptions.token}
          onSuccess={() => setCurrentPage('dashboard')}
        />
      );
    }

    if (currentPage === 'reset-password') {
      return (
        <ResetPasswordForm
          token={pageOptions.token}
          onSuccess={() => setCurrentPage('dashboard')}
        />
      );
    }

    if (currentPage === 'insights') {
      return isAuthenticated ? (
        <InsightsHub subscription={subscription} onNavigatePricing={() => navigateTo('pricing')} />
      ) : (
        <AuthForm initialMode="login" onSuccess={() => setCurrentPage('insights')} />
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

    if (currentPage === 'referrals') {
      return isAuthenticated ? (
        <ReferAndEarn
          subscription={subscription}
          onNavigatePricing={() => navigateTo('pricing')}
        />
      ) : (
        <AuthForm initialMode="login" onSuccess={() => setCurrentPage('referrals')} />
      );
    }

    if (currentPage === 'admin') {
      if (!isAuthenticated) {
        return <AuthForm initialMode="login" onSuccess={() => setCurrentPage('admin')} />;
      }
      if (!user?.isAdmin) {
        return (
          <div className="dashboard-card">
            <h2>Admin access required</h2>
            <p>Your account does not have admin privileges. Add your email to ADMIN_EMAILS in backend/.env or set role=admin in MongoDB.</p>
          </div>
        );
      }
      return <AdminHub initialTab={pageOptions.tab || 'dashboard'} />;
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

      <AcceptedPayments />

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
      <AcceptedPayments />
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
