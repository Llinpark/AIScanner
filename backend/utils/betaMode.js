function isBetaMode() {
  return process.env.BETA_MODE === 'true';
}

function getBetaSubscription() {
  const days = parseInt(process.env.BETA_ACCESS_DAYS, 10) || 30;
  const tier = String(process.env.BETA_TIER || 'premium').trim().toLowerCase();
  const end = new Date();
  end.setDate(end.getDate() + days);

  return {
    tier,
    status: 'active',
    provider: 'beta',
    current_period_end: end,
    createdAt: new Date(),
    updatedAt: new Date()
  };
}

module.exports = {
  isBetaMode,
  getBetaSubscription
};
