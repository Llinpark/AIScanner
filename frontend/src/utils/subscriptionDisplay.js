/**
 * Display helpers for subscription/status cards.
 * Admin accounts use role-based unlimited access — never paid-plan tier names.
 */

export function hasAdminUnlimitedAccess(subscription, user) {
  return Boolean(
    subscription?.adminBypass ||
      subscription?.unlimitedAccess ||
      user?.isAdmin ||
      user?.isSuperAdmin
  );
}

export function getPlanDisplayLabel(subscription, user, fallbackTierLabel) {
  if (subscription?.planLabel) return subscription.planLabel;
  if (user?.isSuperAdmin) return 'Super Admin';
  if (user?.isAdmin) return 'Administrator';
  if (subscription?.adminBypass || subscription?.unlimitedAccess) {
    return 'Administrator';
  }
  return fallbackTierLabel || '—';
}

export function getStatusDisplayLabel(subscription, user) {
  if (hasAdminUnlimitedAccess(subscription, user)) {
    return subscription?.statusLabel || 'Unlimited Access';
  }
  const status = subscription?.status || 'inactive';
  if (status === 'active') return 'Active';
  if (status === 'pending') return 'Awaiting Verification';
  if (status === 'expired') return 'Subscription Expired';
  return status;
}

export function getExpiryDisplayLabel(subscription, user, formatDate) {
  if (hasAdminUnlimitedAccess(subscription, user)) {
    return subscription?.expiresLabel || 'Never';
  }
  const raw = subscription?.expiryDate || subscription?.current_period_end;
  if (!raw) return '—';
  return typeof formatDate === 'function' ? formatDate(raw) : String(raw);
}

export function getRemainingDaysDisplay(subscription, user) {
  if (hasAdminUnlimitedAccess(subscription, user)) return 'Unlimited';
  if (subscription?.remainingDays != null) return String(subscription.remainingDays);
  return '—';
}

export function getNavbarTierBadge(subscription, user) {
  if (hasAdminUnlimitedAccess(subscription, user)) {
    const label = getPlanDisplayLabel(subscription, user);
    return {
      className: 'tier-badge tier-admin',
      text: label === 'Super Admin' ? 'SUPER ADMIN' : 'ADMIN'
    };
  }
  const tier = subscription?.tier || 'basic';
  const labels = { basic: 'BASIC', professional: 'PRO', premium: 'PREMIUM' };
  return {
    className: `tier-badge tier-${tier}`,
    text: labels[tier] || String(tier).toUpperCase()
  };
}
