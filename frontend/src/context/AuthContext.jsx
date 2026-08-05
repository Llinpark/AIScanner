import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { authApi, subscriptionApi, setUnauthorizedHandler } from '../services/api';

const AuthContext = createContext(null);

/** Hard cap so Fly cold-starts / Wi‑Fi blackholes cannot stall the UI. */
const AUTH_BOOTSTRAP_TIMEOUT_MS = 4000;

function safeLocalStorageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // iOS private mode / blocked storage must not crash boot.
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // "loading" means session check is in flight — public pages must still render.
  const [loading, setLoading] = useState(true);

  const clearSession = useCallback(() => {
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const response = await authApi.me({ timeout: AUTH_BOOTSTRAP_TIMEOUT_MS });
      setUser(response.data.user);
    } catch {
      clearSession();
    } finally {
      setLoading(false);
    }
  }, [clearSession]);

  useEffect(() => {
    safeLocalStorageRemove('token');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearSession();
    });
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  useEffect(() => {
    let cancelled = false;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

    const finish = () => {
      if (!cancelled) setLoading(false);
    };

    const safetyTimer = window.setTimeout(() => {
      controller?.abort();
      finish();
    }, AUTH_BOOTSTRAP_TIMEOUT_MS);

    (async () => {
      try {
        const response = await authApi.me({
          timeout: AUTH_BOOTSTRAP_TIMEOUT_MS,
          signal: controller?.signal
        });
        if (!cancelled) setUser(response.data.user);
      } catch {
        if (!cancelled) clearSession();
      } finally {
        window.clearTimeout(safetyTimer);
        finish();
      }
    })();

    return () => {
      cancelled = true;
      controller?.abort();
      window.clearTimeout(safetyTimer);
    };
  }, [clearSession]);

  const login = async (email, password) => {
    const response = await authApi.login({ email, password });
    setUser(response.data.user);
    return response.data;
  };

  const register = async payload => {
    const response = await authApi.register(payload);
    if (response.data.user) {
      setUser(response.data.user);
    }
    return response.data;
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } finally {
      clearSession();
    }
  };

  const applySession = useCallback((_token, nextUser) => {
    setUser(nextUser || null);
  }, []);

  const updateUser = nextUser => {
    setUser(nextUser);
  };

  const refreshSubscription = async () => {
    const response = await subscriptionApi.getMe();
    setUser(response.data.user);
    return response.data.user;
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token: null,
        loading,
        isAuthenticated: Boolean(user),
        subscription: user?.subscription || null,
        login,
        register,
        logout,
        applySession,
        updateUser,
        refreshSubscription,
        refreshUser
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
