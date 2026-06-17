import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { authApi, subscriptionApi, setAuthToken } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [loading, setLoading] = useState(true);

  const applySession = useCallback((nextToken, nextUser) => {
    setToken(nextToken || '');
    setUser(nextUser || null);
    setAuthToken(nextToken || null);
    if (nextToken) {
      localStorage.setItem('token', nextToken);
    } else {
      localStorage.removeItem('token');
    }
  }, []);

  const refreshUser = useCallback(async () => {
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setAuthToken(token);
      const response = await authApi.me();
      setUser(response.data.user);
    } catch {
      applySession('', null);
    } finally {
      setLoading(false);
    }
  }, [token, applySession]);

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  const login = async (email, password) => {
    const response = await authApi.login({ email, password });
    applySession(response.data.token, response.data.user);
    return response.data;
  };

  const register = async (payload) => {
    const response = await authApi.register(payload);
    applySession(response.data.token, response.data.user);
    return response.data;
  };

  const logout = () => {
    applySession('', null);
  };

  const updateUser = (nextUser) => {
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
        token,
        loading,
        isAuthenticated: Boolean(user && token),
        subscription: user?.subscription || null,
        login,
        register,
        logout,
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
