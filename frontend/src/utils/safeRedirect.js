const ALLOWED_CHECKOUT_HOSTS = [
  'paypal.com',
  'www.paypal.com',
  'sandbox.paypal.com',
  'binance.com',
  'www.binance.com'
];

export function isAllowedCheckoutUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') return false;

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  return ALLOWED_CHECKOUT_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

export function redirectToCheckout(urlString) {
  if (!isAllowedCheckoutUrl(urlString)) {
    throw new Error('Unsafe payment redirect URL.');
  }
  window.location.href = urlString;
}
