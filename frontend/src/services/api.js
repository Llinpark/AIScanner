import axios from 'axios';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

// Create axios instance
export const api = axios.create({
  baseURL: BACKEND_URL
});

export async function fetchSignals() {
  const response = await api.get('/api/signals');
  return response.data;
}

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
};

export const scannerApi = {
  getStatus: () => api.get('/api/scanner/status'),
  getPatterns: () => api.get('/api/scanner/patterns'),
  runScan: (symbol) => api.post('/api/scanner/run', symbol ? { symbol } : {}),
  sendCandle: (payload) => api.post('/api/scanner/candle', payload)
};

