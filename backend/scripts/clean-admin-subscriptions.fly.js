/**
 * Reset admin accounts' subscription/payment state in production.
 * Keeps accounts + roles; clears paid-plan ties so access comes from admin bypass.
 *
 * Run on Fly:
 *   flyctl ssh console -a kaching-api -C "node /app/scripts/clean-admin-subscriptions.fly.js"
 */
const mongoose = require('/app/node_modules/mongoose');
const UserConfig = require('/app/models/User');
const PaymentTransaction = require('/app/models/PaymentTransaction');

const ADMIN_EMAILS = [
  'collinspark1985@gmail.com',
  'barasajohn1985@gmail.com',
  'lilianmonari15@gmail.com'
];

const CLEAN_SUBSCRIPTION = {
  tier: 'basic',
  status: 'inactive',
  provider: undefined,
  providerCustomerId: undefined,
  providerSubscriptionId: undefined,
  providerOrderId: undefined,
  current_period_end: undefined,
  billingCycle: 'monthly',
  updatedAt: new Date()
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  const users = await UserConfig.find({ email: { $in: ADMIN_EMAILS } })
    .select('_id email role subscription')
    .lean();

  if (!users.length) {
    console.error('No admin users found for cleanup.');
    process.exit(1);
  }

  const foundEmails = users.map(u => u.email);
  const missing = ADMIN_EMAILS.filter(e => !foundEmails.includes(e));
  if (missing.length) {
    console.warn('Missing admin emails (not deleted, just not found):', missing.join(', '));
  }

  const userIds = users.map(u => u._id);

  const before = users.map(u => ({
    email: u.email,
    role: u.role,
    subscription: u.subscription || null
  }));

  const paymentDelete = await PaymentTransaction.deleteMany({ userId: { $in: userIds } });

  const updateResult = await UserConfig.updateMany(
    { _id: { $in: userIds } },
    {
      $set: {
        'subscription.tier': 'basic',
        'subscription.status': 'inactive',
        'subscription.billingCycle': 'monthly',
        'subscription.updatedAt': new Date()
      },
      $unset: {
        'subscription.provider': '',
        'subscription.providerCustomerId': '',
        'subscription.providerSubscriptionId': '',
        'subscription.providerOrderId': '',
        'subscription.current_period_end': ''
      }
    }
  );

  // Re-affirm roles (do not wipe admin/super_admin).
  await UserConfig.updateOne(
    { email: 'collinspark1985@gmail.com' },
    { $set: { role: 'super_admin' } }
  );
  await UserConfig.updateMany(
    { email: { $in: ['barasajohn1985@gmail.com', 'lilianmonari15@gmail.com'] } },
    { $set: { role: 'admin' } }
  );

  const after = await UserConfig.find({ email: { $in: ADMIN_EMAILS } })
    .select('email role subscription')
    .lean();

  console.log(
    JSON.stringify(
      {
        cleaned: true,
        paymentsDeleted: paymentDelete.deletedCount || 0,
        usersMatched: updateResult.matchedCount || updateResult.n,
        usersModified: updateResult.modifiedCount || updateResult.nModified,
        before,
        after
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
})().catch(async e => {
  console.error(e.message || e);
  process.exit(1);
});
