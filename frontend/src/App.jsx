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
import SeoHead from './components/SeoHead';
import { AuthProvider, useAuth } from './context/AuthContext';
import { fetchSignals } from './services/api';
import { storeReferralCode } from './utils/referralStorage';
import { pageFromPath, pathForPage } from './seo/routes';
import { usePathRouting } from './seo/usePathRouting';

function AppContent() {
  const { user, subscription, loading, logout, isAuthenticated, refreshSubscription } = useAuth();
  const [signals, setSignals] = useState([]);
  const [currentPage, setCurrentPage] = useState(() => pageFromPath(window.location.pathname));
  const [previousPage, setPreviousPage] = useState('home');
  const [pageOptions, setPageOptions] = useState({});
  const [paymentNotice, setPaymentNotice] = useState('');

  const navigateTo = usePathRouting({
    currentPage,
    setCurrentPage,
    setPageOptions,
    setPreviousPage
  });

  const closeRiskDisclosure = () => {
    navigateTo(previousPage || 'home');
  };

  const handleLogout = () => {
    logout();
    navigateTo('home', {}, { replace: true });
  };

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
    const paystackStatus = params.get('paystack');

    if (refCode) {
      storeReferralCode(refCode);
      if (!verifyToken && !resetToken && !paypalStatus && !binanceStatus && !paystackStatus) {
        navigateTo('signup', {}, { replace: true });
      } else {
        window.history.replaceState(
          { page: currentPage, options: pageOptions },
          '',
          pathForPage(currentPage)
        );
      }
    }

    if (verifyToken) {
      navigateTo('verify-email', { token: verifyToken }, { replace: true });
      return;
    }

    if (resetToken) {
      navigateTo('reset-password', { token: resetToken }, { replace: true });
      return;
    }

    if (paystackStatus) {
      if (paystackStatus === 'success') {
        refreshSubscription().then(() => {
          setPaymentNotice('Paystack payment successful! Your subscription is now active.');
          navigateTo('pricing', {}, { replace: true });
        });
      } else if (paystackStatus === 'cancelled') {
        setPaymentNotice('Paystack payment was cancelled.');
        navigateTo('pricing', {}, { replace: true });
      } else if (paystackStatus === 'mock') {
        navigateTo('pricing', {}, { replace: true });
      } else if (paystackStatus === 'error') {
        setPaymentNotice(`Paystack payment failed: ${params.get('message') || 'Unknown error'}`);
        navigateTo('pricing', {}, { replace: true });
      }
      return;
    }

    if (binanceStatus) {
      if (binanceStatus === 'success') {
        refreshSubscription().then(() => {
          setPaymentNotice('Binance Pay payment successful! Your subscription is now active.');
          navigateTo('pricing', {}, { replace: true });
        });
      } else if (binanceStatus === 'cancelled') {
        setPaymentNotice('Binance Pay payment was cancelled.');
        navigateTo('pricing', {}, { replace: true });
      } else if (binanceStatus === 'pending') {
        setPaymentNotice(
          'Binance Pay payment is still processing. We will activate your subscription once it confirms.'
        );
        navigateTo('pricing', {}, { replace: true });
      } else if (binanceStatus === 'mock') {
        navigateTo('pricing', {}, { replace: true });
      } else if (binanceStatus === 'error') {
        setPaymentNotice(`Binance Pay payment failed: ${params.get('message') || 'Unknown error'}`);
        navigateTo('pricing', {}, { replace: true });
      }
      return;
    }

    if (!paypalStatus) return;

    if (paypalStatus === 'success') {
      refreshSubscription().then(() => {
        setPaymentNotice('PayPal payment successful! Your subscription is now active.');
        navigateTo('pricing', {}, { replace: true });
      });
    } else if (paypalStatus === 'cancelled') {
      setPaymentNotice('PayPal payment was cancelled.');
      navigateTo('pricing', {}, { replace: true });
    } else if (paypalStatus === 'error') {
      setPaymentNotice(`PayPal payment failed: ${params.get('message') || 'Unknown error'}`);
      navigateTo('pricing', {}, { replace: true });
    } else if (paypalStatus === 'mock') {
      navigateTo('pricing', {}, { replace: true });
    }
    // navigateTo is stable enough for query bootstrap; include refreshSubscription only
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            onViewPricing={() => navigateTo('pricing')}
            onSignUp={() => navigateTo('signup')}
            onReferEarn={() => navigateTo('referrals')}
          />
          <TradingEcosystem />
          <AiIntelligenceSection
            onViewPricing={() => navigateTo('pricing')}
            onSignUp={() => navigateTo('signup')}
          />
        </>
      );
    }

    if (currentPage === 'signin') {
      return (
        <AuthForm initialMode="login" onSuccess={() => navigateTo('dashboard', {}, { replace: true })} />
      );
    }

    if (currentPage === 'signup') {
      return (
        <AuthForm initialMode="register" onSuccess={() => navigateTo('pricing', {}, { replace: true })} />
      );
    }

    if (currentPage === 'verify-email') {
      return (
        <VerifyEmailPage
          token={pageOptions.token}
          onSuccess={() => navigateTo('dashboard', {}, { replace: true })}
        />
      );
    }

    if (currentPage === 'reset-password') {
      return (
        <ResetPasswordForm
          token={pageOptions.token}
          onSuccess={() => navigateTo('dashboard', {}, { replace: true })}
        />
      );
    }

    if (currentPage === 'insights') {
      return isAuthenticated ? (
        <InsightsHub subscription={subscription} onNavigatePricing={() => navigateTo('pricing')} />
      ) : (
        <AuthForm initialMode="login" onSuccess={() => navigateTo('insights', {}, { replace: true })} />
      );
    }

    if (currentPage === 'dashboard') {
      return isAuthenticated ? (
        <SignalDashboard
          initialSignals={signals}
          subscription={subscription}
          onNavigateReferrals={() => navigateTo('referrals')}
        />
      ) : (
        <AuthForm
          initialMode="login"
          onSuccess={() => navigateTo('dashboard', {}, { replace: true })}
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
          onSuccess={() => navigateTo('tradingview', pageOptions, { replace: true })}
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
        <AuthForm
          initialMode="login"
          authNotice="Sign in or register to open Refer & Earn and get your personal referral link."
          onSuccess={() => navigateTo('referrals', {}, { replace: true })}
        />
      );
    }

    if (currentPage === 'admin') {
      if (!isAuthenticated) {
        return <AuthForm initialMode="login" onSuccess={() => navigateTo('admin', {}, { replace: true })} />;
      }
      if (!user?.isAdmin) {
        return (
          <div className="dashboard-card">
            <h2>Admin access required</h2>
            <p>
              Your account does not have admin privileges. Add your email to ADMIN_EMAILS in
              backend/.env or set role=admin in MongoDB.
            </p>
          </div>
        );
      }
      return <AdminHub initialTab={pageOptions.tab || 'dashboard'} />;
    }

    return (
      <Pricing
        onSubscriptionUpdated={refreshSubscription}
        onNavigateDashboard={() => navigateTo('dashboard')}
        onNavigateReferrals={() => navigateTo('referrals')}
        onSignIn={() => navigateTo('signin')}
      />
    );
  };

  return (
    <div className="site-layout">
      <SeoHead page={currentPage} />
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

      <main className={`site-main${currentPage === 'admin' ? ' site-main--admin' : ''}`}>
        {paymentNotice && <div className="page-notice info-box">{paymentNotice}</div>}

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
      <SeoHead page={pageFromPath(typeof window !== 'undefined' ? window.location.pathname : '/')} />
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
