const APP_DOMAIN = (process.env.APP_DOMAIN || 'kachingscanner.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
const isProduction = process.env.NODE_ENV === 'production';
const defaultPort = parseInt(process.env.PORT, 10) || 4000;

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (isProduction ? `https://${APP_DOMAIN}` : 'http://localhost:5173');

const PUBLIC_BACKEND_URL =
  process.env.PUBLIC_BACKEND_URL ||
  (isProduction ? `https://api.${APP_DOMAIN}` : `http://localhost:${defaultPort}`);

const CORS_ORIGINS = Array.from(
  new Set(
    [
      FRONTEND_URL,
      `https://${APP_DOMAIN}`,
      `https://www.${APP_DOMAIN}`,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      ...(process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean)
    ].filter(Boolean)
  )
);

const WEBHOOK_TRADINGVIEW_URL = `${PUBLIC_BACKEND_URL.replace(/\/$/, '')}/api/webhook/tradingview`;
const WEBHOOK_MPESA_URL = `${PUBLIC_BACKEND_URL.replace(/\/$/, '')}/api/webhook/mpesa`;
const WEBHOOK_BINANCE_URL = `${PUBLIC_BACKEND_URL.replace(/\/$/, '')}/api/webhook/binance`;
const WEBHOOK_SASAPAY_URL = `${PUBLIC_BACKEND_URL.replace(/\/$/, '')}/api/webhook/sasapay`;
const WEBHOOK_PAYSTACK_URL = `${PUBLIC_BACKEND_URL.replace(/\/$/, '')}/api/webhook/paystack`;
const WEBHOOK_TELEGRAM_URL = `${PUBLIC_BACKEND_URL.replace(/\/$/, '')}/api/webhook/telegram`;
const PAYSTACK_CALLBACK_URL = `${PUBLIC_BACKEND_URL.replace(/\/$/, '')}/api/payments/paystack/callback`;
const TRADINGVIEW_OAUTH_CALLBACK_URL = `${PUBLIC_BACKEND_URL.replace(/\/$/, '')}/api/tradingview/oauth-callback`;

module.exports = {
  APP_DOMAIN,
  FRONTEND_URL,
  PUBLIC_BACKEND_URL,
  CORS_ORIGINS,
  WEBHOOK_TRADINGVIEW_URL,
  WEBHOOK_MPESA_URL,
  WEBHOOK_BINANCE_URL,
  WEBHOOK_SASAPAY_URL,
  WEBHOOK_PAYSTACK_URL,
  WEBHOOK_TELEGRAM_URL,
  PAYSTACK_CALLBACK_URL,
  TRADINGVIEW_OAUTH_CALLBACK_URL
};
