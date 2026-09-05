const REFERRAL_STORAGE_KEY = 'kachingfx_ref';
const REFERRAL_ATTRIBUTION_MS = 30 * 24 * 60 * 60 * 1000;

export function storeReferralCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return;
  localStorage.setItem(
    REFERRAL_STORAGE_KEY,
    JSON.stringify({
      code: normalized,
      storedAt: Date.now()
    })
  );
}

export function getStoredReferralCode() {
  try {
    const raw = localStorage.getItem(REFERRAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.code || !parsed?.storedAt) {
      localStorage.removeItem(REFERRAL_STORAGE_KEY);
      return null;
    }
    if (Date.now() - parsed.storedAt > REFERRAL_ATTRIBUTION_MS) {
      localStorage.removeItem(REFERRAL_STORAGE_KEY);
      return null;
    }
    return parsed.code;
  } catch {
    localStorage.removeItem(REFERRAL_STORAGE_KEY);
    return null;
  }
}

export function clearStoredReferralCode() {
  localStorage.removeItem(REFERRAL_STORAGE_KEY);
}
