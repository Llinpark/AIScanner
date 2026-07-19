import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../services/api';

function formatFieldErrors(errors) {
  if (!errors?.length) return null;
  return errors.map(err => `${err.field}: ${err.message}`).join(' ');
}

export default function ResetPasswordForm({ token, onSuccess }) {
  const { applySession } = useAuth();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const response = await authApi.resetPassword({ token, password });
      applySession(null, response.data.user);
      onSuccess?.();
    } catch (err) {
      const apiError = err.response?.data;
      setError(
        formatFieldErrors(apiError?.errors) ||
          apiError?.message ||
          'Unable to reset password.'
      );
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="login-container">
        <div className="login-card auth-card">
          <h2>Invalid reset link</h2>
          <p>This password reset link is missing or invalid.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card auth-card">
        <h2>Set a new password</h2>
        <p>Choose a new password for your account.</p>

        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label htmlFor="newPassword">New password</label>
            <div className="password-input-wrap">
              <input
                id="newPassword"
                type={showPassword ? 'text' : 'password'}
                placeholder="Min 8 chars, letter + number"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="new-password"
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
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword">Confirm password</label>
            <input
              id="confirmPassword"
              type={showPassword ? 'text' : 'password'}
              placeholder="Repeat your password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>

          {error && <div className="app-error auth-error">{error}</div>}

          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}
