import axios from 'axios';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

export const api = axios.create({
  baseURL: BACKEND_URL
});

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

export async function fetchSignals() {
  const response = await api.get('/api/signals');
  return response.data;
}

export const authApi = {
  register: payload => api.post('/api/auth/register', payload),
  login: payload => api.post('/api/auth/login', payload),
  me: () => api.get('/api/auth/me')
};

export const subscriptionApi = {
  getTiers: () => api.get('/api/tiers'),
  subscribe: payload => api.post('/api/subscribe', payload),
  getMe: () => api.get('/api/subscription/me'),
  confirmMockPayment: payload => api.post('/api/payments/mock/confirm', payload),
  getMpesaStatus: checkoutRequestId => api.get(`/api/payments/mpesa/status/${checkoutRequestId}`),
  confirmMpesaMock: payload => api.post('/api/payments/mpesa/mock-complete', payload),
  confirmPaypalMock: payload => api.post('/api/payments/paypal/mock-complete', payload),
  getPerformanceSummary: () => api.get('/api/performance/summary')
};

export const tradingviewApi = {
  getSetup: () => api.get('/api/tradingview/setup'),
  getAlerts: (symbol) =>
    api.get('/api/tradingview/alerts', { params: symbol ? { symbol } : {} }),
  getPineScript: () => api.get('/api/tradingview/pine-script'),
  getHistory: (symbol, options = {}) => api.get(`/api/tradingview/history/${symbol}`, { params: options })
};

export const scannerApi = {
  getStatus: () => api.get('/api/scanner/status'),
  getPatterns: () => api.get('/api/scanner/patterns'),
  runScan: (symbol) => api.post('/api/scanner/run', symbol ? { symbol } : {})
};
