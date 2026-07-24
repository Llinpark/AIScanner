import axios from 'axios';
import { BACKEND_URL } from '../config/appUrls';

export const api = axios.create({
  baseURL: BACKEND_URL,
  withCredentials: true
});

let unauthorizedHandler = null;

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

export function setAuthToken() {
  // Sessions are stored in httpOnly cookies; no Authorization header needed.
}

api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401 && unauthorizedHandler) {
      unauthorizedHandler();
    }
    return Promise.reject(error);
  }
);

function logClientError(context, error) {
  const message =
    error?.response?.data?.message ||
    error?.message ||
    'Request failed';
  console.error(context, message);
}

export { logClientError };

export async function fetchSignals() {
  const response = await api.get('/api/signals');
  return response.data;
}

export const authApi = {
  register: payload => api.post('/api/auth/register', payload),
  login: payload => api.post('/api/auth/login', payload),
  logout: () => api.post('/api/auth/logout'),
  me: () => api.get('/api/auth/me'),
  forgotPassword: payload => api.post('/api/auth/forgot-password', payload),
  resetPassword: payload => api.post('/api/auth/reset-password', payload),
  verifyEmail: token => api.get('/api/auth/verify-email', { params: { token } }),
  resendVerification: payload => api.post('/api/auth/resend-verification', payload)
};

export const subscriptionApi = {
  getTiers: () => api.get('/api/tiers'),
  subscribe: payload => api.post('/api/subscribe', payload),
  getMe: () => api.get('/api/subscription/me'),
  confirmMockPayment: payload => api.post('/api/payments/mock/confirm', payload),
  getMpesaStatus: checkoutRequestId => api.get(`/api/payments/mpesa/status/${checkoutRequestId}`),
  confirmMpesaMock: payload => api.post('/api/payments/mpesa/mock-complete', payload),
  confirmPaypalMock: payload => api.post('/api/payments/paypal/mock-complete', payload),
  getBinanceStatus: merchantTradeNo => api.get(`/api/payments/binance/status/${merchantTradeNo}`),
  confirmBinanceMock: payload => api.post('/api/payments/binance/mock-complete', payload),
  getSasaPayStatus: checkoutRequestId => api.get(`/api/payments/sasapay/status/${checkoutRequestId}`),
  confirmSasaPayMock: payload => api.post('/api/payments/sasapay/mock-complete', payload),
  getPaystackStatus: reference => api.get(`/api/payments/paystack/status/${reference}`),
  confirmPaystackMock: payload => api.post('/api/payments/paystack/mock-complete', payload),
  getPerformanceSummary: () => api.get('/api/performance/summary')
};

export const analyticsApi = {
  getSummary: () => api.get('/api/analytics/summary'),
  getTimeseries: () => api.get('/api/analytics/timeseries'),
  getHistory: params => api.get('/api/analytics/history', { params })
};

export const journalApi = {
  list: () => api.get('/api/journal'),
  create: payload => api.post('/api/journal', payload),
  update: (id, payload) => api.put(`/api/journal/${id}`, payload),
  remove: id => api.delete(`/api/journal/${id}`)
};

export const telegramApi = {
  getStatus: () => api.get('/api/telegram/status'),
  createLinkCode: () => api.post('/api/telegram/link-code'),
  unlink: () => api.post('/api/telegram/unlink'),
  toggle: enabled => api.post('/api/telegram/toggle', { enabled })
};

export const mt5Api = {
  getStatus: () => api.get('/api/mt5/status'),
  createLinkToken: () => api.post('/api/mt5/link-token'),
  updateSettings: payload => api.post('/api/mt5/settings', payload)
};

export const tradingviewApi = {
  getSetup: () => api.get('/api/tradingview/setup'),
  getAlerts: symbol =>
    api.get('/api/tradingview/alerts', { params: symbol ? { symbol } : {} }),
  getPineScript: () => api.get('/api/tradingview/pine-script'),
  getHistory: (symbol, options = {}) => api.get(`/api/tradingview/history/${symbol}`, { params: options })
};

export const marketDataApi = {
  getCandles: (symbol, options = {}) =>
    api.get('/api/market-data/candles', {
      params: { symbol, interval: options.interval || '1h', limit: options.limit || 200 },
      timeout: options.timeout || 25000
    }),
  getStatus: () => api.get('/api/market-data/status')
};

export const scannerApi = {
  getStatus: () => api.get('/api/scanner/status'),
  getPatterns: () => api.get('/api/scanner/patterns'),
  analyze: (symbol, options = {}) =>
    api.get('/api/scanner/analyze', {
      params: { symbol, interval: options.interval || '1h' },
      timeout: options.timeout || 25000
    }),
  runScan: symbol => api.post('/api/scanner/run', symbol ? { symbol } : {})
};

export const referralApi = {
  getMe: () => api.get('/api/referrals/me')
};

export const adminApi = {
  getStats: () => api.get('/api/admin/stats'),
  getUsers: (params = {}) => api.get('/api/admin/users', { params }),
  getUser: id => api.get(`/api/admin/users/${id}`),
  updateUserSubscription: (id, payload) => api.patch(`/api/admin/users/${id}/subscription`, payload),
  getSignals: (params = {}) => api.get('/api/admin/signals', { params }),
  getSignalDuplicates: (params = {}) => api.get('/api/admin/signals/duplicates', { params }),
  dedupeSignals: payload => api.post('/api/admin/signals/dedupe', payload),
  closeStaleSignals: payload => api.post('/api/admin/signals/close-stale', payload),
  updateSignalOutcome: (id, payload) => api.patch(`/api/admin/signals/${id}/outcome`, payload),
  getPayments: (params = {}) => api.get('/api/admin/payments', { params }),
  getPaymentsSummary: () => api.get('/api/admin/payments/summary'),
  getAuditLog: (params = {}) => api.get('/api/admin/audit-log', { params }),
  getScannerConfig: () => api.get('/api/admin/scanner/config'),
  updateScannerConfig: payload => api.patch('/api/admin/scanner/config', payload),
  getReferrals: (params = {}) => api.get('/api/admin/referrals', { params }),
  markReferralPaid: (id, payload) => api.patch(`/api/admin/referrals/${id}/pay`, payload)
};
