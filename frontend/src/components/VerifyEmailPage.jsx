import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../services/api';

/** Shared across StrictMode remounts so verify-email is called once per token. */
const verifyPromises = new Map();

export default function VerifyEmailPage({ token, onSuccess }) {
  const { applySession } = useAuth();
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('Verifying your email…');
  const onSuccessRef = useRef(onSuccess);
  const applySessionRef = useRef(applySession);

  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  useEffect(() => {
    applySessionRef.current = applySession;
  }, [applySession]);

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('This verification link is missing or invalid.');
      return;
    }

    let cancelled = false;

    let promise = verifyPromises.get(token);
    if (!promise) {
      promise = authApi.verifyEmail(token);
      verifyPromises.set(token, promise);
    }

    promise
      .then(response => {
        if (cancelled) return;
        applySessionRef.current?.(null, response.data.user);
        setStatus('success');
        setMessage(response.data.message || 'Email verified successfully.');
        onSuccessRef.current?.();
      })
      .catch(err => {
        verifyPromises.delete(token);
        if (cancelled) return;
        setStatus('error');
        setMessage(err.response?.data?.message || 'Unable to verify email.');
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

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
