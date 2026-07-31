function parseEmailList(value) {
  return String(value || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function parseAdminEmails() {
  return parseEmailList(process.env.ADMIN_EMAILS);
}

/** Canonical super-admin email when SUPER_ADMIN_EMAILS is unset. */
const DEFAULT_SUPER_ADMIN_EMAIL = 'collinspark1985@gmail.com';

function parseSuperAdminEmails() {
  const explicit = parseEmailList(process.env.SUPER_ADMIN_EMAILS);
  if (explicit.length) return explicit;
  // Default super-admin when env is unset (production bootstrap).
  return [DEFAULT_SUPER_ADMIN_EMAIL];
}

function normalizeRole(user) {
  return String(user?.role || 'user').trim().toLowerCase();
}

/**
 * Super-admin (Scanner config) requires an allowlisted email.
 * DB role alone is never enough — prevents accidental promotion.
 */
function isSuperAdmin(user) {
  if (!user) return false;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return false;
  return parseSuperAdminEmails().includes(email);
}

function isAdmin(user) {
  if (!user) return false;
  if (isSuperAdmin(user)) return true;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return false;
  const role = normalizeRole(user);
  // Stale super_admin role still counts as general admin after demotion lag.
  if (role === 'admin' || role === 'super_admin') return true;
  return parseAdminEmails().includes(email);
}

function canManageScannerConfig(user) {
  return isSuperAdmin(user);
}

module.exports = {
  DEFAULT_SUPER_ADMIN_EMAIL,
  parseAdminEmails,
  parseSuperAdminEmails,
  isAdmin,
  isSuperAdmin,
  canManageScannerConfig
};
