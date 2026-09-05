/** Page id ↔ URL path map for History API routing. */

export const PAGE_PATHS = {
  home: '/',
  pricing: '/pricing',
  contact: '/contact',
  'risk-disclosure': '/risk-disclosure',
  signin: '/signin',
  signup: '/signup',
  referrals: '/referrals',
  dashboard: '/dashboard',
  insights: '/insights',
  tradingview: '/tradingview',
  admin: '/admin',
  'verify-email': '/verify-email',
  'reset-password': '/reset-password'
};

const PATH_TO_PAGE = Object.fromEntries(
  Object.entries(PAGE_PATHS).map(([page, path]) => [path, page])
);

export function pathForPage(page) {
  return PAGE_PATHS[page] || '/';
}

export function pageFromPath(pathname) {
  const normalized = (pathname || '/').replace(/\/+$/, '') || '/';
  return PATH_TO_PAGE[normalized] || PATH_TO_PAGE[pathname] || 'home';
}

export function isKnownPath(pathname) {
  const normalized = (pathname || '/').replace(/\/+$/, '') || '/';
  return Boolean(PATH_TO_PAGE[normalized] || PATH_TO_PAGE[pathname]);
}
