const APP_DOMAIN = (import.meta.env.VITE_APP_DOMAIN || 'kachingscanner.com').replace(/^https?:\/\//, '').replace(/\/$/, '');

export const SITE_URL = import.meta.env.VITE_SITE_URL || (import.meta.env.DEV ? 'http://localhost:5173' : `https://${APP_DOMAIN}`);

export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  (import.meta.env.DEV ? '' : `https://api.${APP_DOMAIN}`);

export const MARKET_DATA_WS_URL =
  import.meta.env.VITE_MARKET_DATA_WS_URL ||
  (import.meta.env.DEV ? 'ws://localhost:8001' : `wss://market.${APP_DOMAIN}`);

export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || BACKEND_URL || undefined;

export const CONTACT_EMAIL = `enquiries@${APP_DOMAIN}`;

export const APP_NAME = 'KachingScanner';

export const APP_TAGLINE = 'AI Trading Intelligence Platform';

export const APP_PAGE_TITLE = `${APP_NAME} — ${APP_TAGLINE}`;

export const APP_DESCRIPTION =
  'KachingScanner is an AI Trading Intelligence Platform — smart market analysis, premium SMC signals, live charts, TradingView alerts, and optional automated execution.';

export const OG_IMAGE_PATH = '/hero-img.png';

export const OG_IMAGE_URL = `${SITE_URL.replace(/\/$/, '')}${OG_IMAGE_PATH}`;

export const THEME_COLOR = '#0b1220';
