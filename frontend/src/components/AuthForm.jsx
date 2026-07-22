import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../services/api';
import { clearStoredReferralCode, getStoredReferralCode } from '../utils/referralStorage';

function formatFieldErrors(errors) {
  if (!errors?.length) return null;
  return errors.map(err => `${err.field}: ${err.message}`).join(' ');
}

export default function AuthForm({ onSuccess, initialMode = 'login', authNotice }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState('');

  const resetMessages = () => {
    setError('');
    setInfo('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    resetMessages();
    setLoading(true);

    try {
      if (mode === 'forgot') {
        const response = await authApi.forgotPassword({ email: email.trim() });
        setInfo(response.data.message);
        return;
      }

      if (mode === 'login') {
        await login(email.trim(), password);
        onSuccess?.();
        return;
      }

      const referralCode = getStoredReferralCode();
      const result = await register({
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
        phone: phone.trim() || undefined,
        referralCode: referralCode || undefined
      });

      if (referralCode) {
        clearStoredReferralCode();
      }

      if (result.requiresVerification) {
        setPendingVerificationEmail(result.email || email.trim());
        if (result.emailDeliveryFailed) {
          setError(result.message);
        } else {
          setInfo(result.message);
        }
        return;
      }

      onSuccess?.();
    } catch (err) {
      const apiError = err.response?.data;
      if (apiError?.code === 'EMAIL_NOT_VERIFIED') {
        setPendingVerificationEmail(apiError.email || email.trim());
        setError(apiError.message);
        return;
      }
      setError(
        formatFieldErrors(apiError?.errors) ||
          apiError?.message ||
          'Something went wrong. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    const targetEmail = pendingVerificationEmail || email.trim();
    if (!targetEmail) return;

    resetMessages();
    setLoading(true);
    try {
      const response = await authApi.resendVerification({ email: targetEmail });
      setInfo(response.data.message);
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to resend verification email.');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (nextMode) => {
    setMode(nextMode);
    resetMessages();
    setPendingVerificationEmail('');
    setShowPassword(false);
  };

  if (pendingVerificationEmail && mode === 'register') {
    return (
      <div className="login-container">
        <div className="login-card auth-card">
          <h2>Check your email</h2>
          <p>
            We sent a verification link to <strong>{pendingVerificationEmail}</strong>.
            Open the link to activate your account, then sign in.
          </p>
          {info && <div className="auth-info">{info}</div>}
          {error && <div className="app-error auth-error">{error}</div>}
          <button
            type="button"
            className="btn-primary auth-action-btn"
            onClick={handleResendVerification}
            disabled={loading}
          >
            {loading ? 'Sending…' : 'Resend verification email'}
          </button>
          <p className="auth-toggle">
            Already verified?{' '}
            <button type="button" className="btn-link-inline" onClick={() => switchMode('login')}>
              Sign in
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card auth-card">
        <h2>
          {mode === 'login' ? 'Login' : mode === 'register' ? 'Register' : 'Forgot password'}
        </h2>
        {authNotice && <p className="auth-notice">{authNotice}</p>}
        <p>
          {mode === 'login'
            ? 'Access your trading signals dashboard.'
            : mode === 'register'
              ? 'Register, verify your email, subscribe, then open Trading View for Kaching Entry, Kaching SL and Kaching TP alerts.'
              : 'Enter your account email and we will send you a reset link.'}
        </p>

        <form onSubmit={handleSubmit} className="auth-form">
          {mode === 'register' && (
            <div className="form-group">
              <label htmlFor="displayName">Display name</label>
              <input
                id="displayName"
                type="text"
                placeholder="Your name"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                autoComplete="name"
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>

          {mode !== 'forgot' && (
            <div className="form-group">
              <label htmlFor="password">Password</label>
              <div className="password-input-wrap">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder={mode === 'register' ? 'Min 8 chars, letter + number' : 'Your password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => setShowPassword(prev => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                >
                  {showPassword ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M12 6c3.79 0 7.17 2.13 8.82 5.5-1.01 1.97-2.6 3.59-4.54 4.57l1.46 1.46C19.07 16.29 20.5 14.18 21.64 12 19.53 7.61 16.04 5 12 5c-1.15 0-2.26.17-3.31.48l1.57 1.57C10.74 6.06 11.35 6 12 6zM2.71 3.16 1.29 4.58l2.13 2.13C2.39 8.14 1.12 9.96 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l2.35 2.35 1.42-1.42L2.71 3.16zM12 17c-2.76 0-5-2.24-5-5 0-1.02.31-1.96.84-2.75l3.91 3.91c-.79.53-1.73.84-2.75.84zm-3.27-8.73 3.91 3.91c.04-.34.07-.69.07-1.05 0-2.21-1.79-4-4-4-.36 0-.71.03-1.05.07z"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"
                      />
                    </svg>
                  )}
                </button>
              </div>
              {mode === 'login' && (
                <button
                  type="button"
                  className="btn-link-inline auth-forgot-link"
                  onClick={() => switchMode('forgot')}
                >
                  Forgot password?
                </button>
              )}
            </div>
          )}

          {mode === 'register' && (
            <div className="form-group">
              <label htmlFor="phone">Phone (optional, for M-Pesa)</label>
              <input
                id="phone"
                type="tel"
                placeholder="+254712345678"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                autoComplete="tel"
              />
            </div>
          )}

          {info && <div className="auth-info">{info}</div>}
          {error && <div className="app-error auth-error">{error}</div>}

          {error && mode === 'login' && pendingVerificationEmail && (
            <button
              type="button"
              className="btn-link-inline auth-resend-link"
              onClick={handleResendVerification}
              disabled={loading}
            >
              Resend verification email
            </button>
          )}

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading
              ? 'Please wait…'
              : mode === 'login'
                ? 'Login'
                : mode === 'register'
                  ? 'Register'
                  : 'Send reset link'}
          </button>
        </form>

        <p className="auth-toggle">
          {mode === 'forgot' ? (
            <>
              Remember your password?{' '}
              <button type="button" className="btn-link-inline" onClick={() => switchMode('login')}>
                Back to login
              </button>
            </>
          ) : mode === 'login' ? (
            <>
              Don&apos;t have an account?{' '}
              <button type="button" className="btn-link-inline" onClick={() => switchMode('register')}>
                Register
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button type="button" className="btn-link-inline" onClick={() => switchMode('login')}>
                Login
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
