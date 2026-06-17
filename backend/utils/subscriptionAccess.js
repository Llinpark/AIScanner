function isSubscriptionActive(subscription) {
  if (!subscription) return false;
  if (subscription.status === 'active') {
    if (subscription.current_period_end && new Date(subscription.current_period_end) < new Date()) {
      return false;
    }
    return true;
  }
  if (subscription.status === 'trial') {
    if (subscription.trialEnds && new Date(subscription.trialEnds) < new Date()) {
      return false;
    }
    return true;
  }
  return false;
}

<<<<<<< HEAD
function canAccessLiveAlerts(subscription) {
=======
function canAccessTradingViewAlerts(subscription) {
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
  return isSubscriptionActive(subscription);
}

module.exports = {
  isSubscriptionActive,
<<<<<<< HEAD
  canAccessLiveAlerts,
  canAccessTradingViewAlerts: canAccessLiveAlerts
=======
  canAccessTradingViewAlerts
>>>>>>> c02b076342de1b7d0ffc5033ab654cb2c655c162
};
