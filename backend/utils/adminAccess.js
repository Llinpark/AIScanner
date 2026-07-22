function parseEmailList(value) {
  return String(value || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function parseAdminEmails() {
  return parseEmailList(process.env.ADMIN_EMAILS);
}

function parseSuperAdminEmails() {
  const explicit = parseEmailList(process.env.SUPER_ADMIN_EMAILS);
  if (explicit.length) return explicit;
  // Default super-admin when env is unset (production bootstrap).
  return ['collinspark1985@gmail.com'];
}

function normalizeRole(user) {
  return String(user?.role || 'user').trim().toLowerCase();
}

function isSuperAdmin(user) {
  if (!user) return false;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return false;
  if (normalizeRole(user) === 'super_admin') return true;
  return parseSuperAdminEmails().includes(email);
}

function isAdmin(user) {
  if (!user) return false;
  if (isSuperAdmin(user)) return true;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return false;
  const role = normalizeRole(user);
  if (role === 'admin' || role === 'super_admin') return true;
  return parseAdminEmails().includes(email);
}

function canManageScannerConfig(user) {
  return isSuperAdmin(user);
}

module.exports = {
  parseAdminEmails,
  parseSuperAdminEmails,
  isAdmin,
  isSuperAdmin,
  canManageScannerConfig
};
