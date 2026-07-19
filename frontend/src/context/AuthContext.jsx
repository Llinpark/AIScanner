import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { authApi, subscriptionApi, setUnauthorizedHandler } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const clearSession = useCallback(() => {
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const response = await authApi.me();
      setUser(response.data.user);
    } catch {
      clearSession();
    } finally {
      setLoading(false);
    }
  }, [clearSession]);

  useEffect(() => {
    localStorage.removeItem('token');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearSession();
    });
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

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

  const applySession = (_token, nextUser) => {
    setUser(nextUser || null);
  };

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
        refreshSubscription
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
