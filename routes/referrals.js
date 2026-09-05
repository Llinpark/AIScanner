const express = require('express');
const requireAuth = require('../middleware/requireAuth');
const ReferralService = require('../services/ReferralService');

const router = express.Router();

router.get('/me', requireAuth, async (req, res) => {
  try {
    const dashboard = await ReferralService.getReferrerDashboard(req.userId);
    res.json(dashboard);
  } catch (error) {
    console.error('Referral dashboard error:', error);
    res.status(error.message === 'User not found' ? 404 : 500).json({
      message: error.message === 'User not found' ? error.message : 'Unable to load referral dashboard',
      error: error.message
    });
  }
});

module.exports = router;
