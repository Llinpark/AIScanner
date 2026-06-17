import axios from 'axios';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

<<<<<<< HEAD
=======
// Create axios instance
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
export const api = axios.create({
  baseURL: BACKEND_URL
});

<<<<<<< HEAD
export function setAuthToken(token) {
  if (token) {
    api.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete api.defaults.headers.common.Authorization;
  }
}

const storedToken = localStorage.getItem('token');
if (storedToken) {
  setAuthToken(storedToken);
}

=======
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
export async function fetchSignals() {
  const response = await api.get('/api/signals');
  return response.data;
}

<<<<<<< HEAD
export const authApi = {
  register: payload => api.post('/api/auth/register', payload),
  login: payload => api.post('/api/auth/login', payload),
  me: () => api.get('/api/auth/me')
};

export const subscriptionApi = {
  getTiers: () => api.get('/api/tiers'),
  subscribe: payload => api.post('/api/subscribe', payload),
  getMe: () => api.get('/api/subscription/me'),
  confirmMockPayment: payload => api.post('/api/payments/mock/confirm', payload)
};

export const tradingviewApi = {
  getSetup: () => api.get('/api/tradingview/setup'),
  getAlerts: (symbol) =>
    api.get('/api/tradingview/alerts', { params: symbol ? { symbol } : {} }),
  getPineScript: () => api.get('/api/tradingview/pine-script'),
  getHistory: (symbol, options = {}) => api.get(`/api/tradingview/history/${symbol}`, { params: options })
=======
// Subscription endpoints
export const subscriptionApi = {
  getTiers: () => api.get('/api/tiers'),
  subscribe: (payload) => api.post('/api/subscribe', payload),
  getSubscription: (username) => api.get(`/api/subscription/${username}`),
  confirmMockPayment: (payload) => api.post('/api/payments/mock/confirm', payload),
  linkTradingView: (payload) => api.post('/api/users/link', payload)
};

// TradingView endpoints
export const tradingviewApi = {
  getOAuthUrl: () => api.get('/api/tradingview/oauth-url'),
  linkAccount: (payload) => api.post('/api/tradingview/link', payload),
  getAccounts: (username) => api.get(`/api/tradingview/accounts/${username}`),
  getHistory: (symbol, options = {}) => api.get(`/api/tradingview/history/${symbol}`, { params: options }),
  getAlerts: (tvUsername, symbol, appUsername) =>
    api.get(`/api/tradingview/alerts/${encodeURIComponent(tvUsername)}/${encodeURIComponent(symbol)}`, {
      params: { username: appUsername }
    }),
  getAllAlerts: (tvUsername, appUsername) =>
    api.get(`/api/tradingview/alerts/${encodeURIComponent(tvUsername)}`, {
      params: { username: appUsername }
    }),
  getPineScript: (tradingviewUsername) =>
    api.get('/api/tradingview/pine-script', { params: { tradingviewUsername } }),
  sendAlert: (payload) => api.post('/api/tradingview/send-alert', payload)
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
};

export const scannerApi = {
  getStatus: () => api.get('/api/scanner/status'),
  getPatterns: () => api.get('/api/scanner/patterns'),
<<<<<<< HEAD
  runScan: (symbol) => api.post('/api/scanner/run', symbol ? { symbol } : {})
};
=======
  runScan: (symbol) => api.post('/api/scanner/run', symbol ? { symbol } : {}),
  sendCandle: (payload) => api.post('/api/scanner/candle', payload)
};

>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
