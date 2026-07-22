const { canManageScannerConfig } = require('../utils/adminAccess');

function requireSuperAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  if (!canManageScannerConfig(req.user)) {
    return res.status(403).json({ message: 'Super admin access required for scanner configuration.' });
  }
  next();
}

module.exports = requireSuperAdmin;
