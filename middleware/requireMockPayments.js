const { isMockPaymentsAllowed } = require('../utils/security');

function requireMockPayments(req, res, next) {
  if (!isMockPaymentsAllowed()) {
    return res.status(404).json({ message: 'Not found' });
  }
  return next();
}

module.exports = requireMockPayments;
