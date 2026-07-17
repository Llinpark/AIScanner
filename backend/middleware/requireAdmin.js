const { isAdmin } = require('../utils/adminAccess');

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  if (!isAdmin(req.user)) {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  next();
}

module.exports = requireAdmin;
