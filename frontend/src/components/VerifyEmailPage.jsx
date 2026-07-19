import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../services/api';

export default function VerifyEmailPage({ token, onSuccess }) {
  const { applySession } = useAuth();
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('Verifying your email…');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('This verification link is missing or invalid.');
      return;
    }

    let cancelled = false;

    authApi
      .verifyEmail(token)
      .then(response => {
        if (cancelled) return;
        applySession(null, response.data.user);
        setStatus('success');
        setMessage(response.data.message || 'Email verified successfully.');
        onSuccess?.();
      })
      .catch(err => {
        if (cancelled) return;
        setStatus('error');
        setMessage(err.response?.data?.message || 'Unable to verify email.');
      });

    return () => {
      cancelled = true;
    };
  }, [token, applySession, onSuccess]);

  return (
    <div className="login-container">
      <div className="login-card auth-card">
        <h2>{status === 'success' ? 'Email verified' : status === 'error' ? 'Verification failed' : 'Verifying email'}</h2>
        <p>{message}</p>
        {status === 'loading' && <div className="loading-state auth-loading">Please wait…</div>}
        {status === 'success' && <div className="auth-info">You are now signed in.</div>}
      </div>
    </div>
  );
}
