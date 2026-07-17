function parseAdminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

function isAdmin(user) {
  if (!user) return false;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return false;
  if (String(user.role || '').toLowerCase() === 'admin') return true;
  return parseAdminEmails().includes(email);
}

module.exports = {
  parseAdminEmails,
  isAdmin
};
