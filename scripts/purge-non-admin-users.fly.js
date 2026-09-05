/* eslint-disable */
const mongoose = require('/app/node_modules/mongoose');
const UserConfig = require('/app/models/User');
const PaymentTransaction = require('/app/models/PaymentTransaction');
const ReferralCommission = require('/app/models/ReferralCommission');
const TradeJournal = require('/app/models/TradeJournal');
const TradeExecution = require('/app/models/TradeExecution');
const { parseAdminEmails } = require('/app/utils/adminAccess');

async function main() {
  if (process.env.CONFIRM_PURGE !== 'YES') {
    console.error('Refusing to run without CONFIRM_PURGE=YES');
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  const adminEmails = parseAdminEmails();
  if (!adminEmails.length) {
    console.error('ADMIN_EMAILS is empty — aborting');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  const keepFilter = {
    $or: [{ email: { $in: adminEmails } }, { role: 'admin' }]
  };

  const keepUsers = await UserConfig.find(keepFilter).select('_id email role').lean();
  const keepIds = keepUsers.map((u) => u._id);
  const toDelete = await UserConfig.find({ _id: { $nin: keepIds } })
    .select('_id email')
    .lean();
  const deleteIds = toDelete.map((u) => u._id);
  const deleteIdStrings = deleteIds.map((id) => String(id));

  console.log(
    JSON.stringify(
      {
        adminEmails,
        totalUsersBefore: await UserConfig.countDocuments(),
        keeping: keepUsers.map((u) => ({ email: u.email, role: u.role })),
        deletingCount: toDelete.length,
        deletingSample: toDelete.slice(0, 30).map((u) => u.email)
      },
      null,
      2
    )
  );

  if (!deleteIds.length) {
    console.log('Nothing to delete.');
    await mongoose.disconnect();
    return;
  }

  const [payments, referrals, journals, executions] = await Promise.all([
    PaymentTransaction.deleteMany({ userId: { $in: deleteIds } }),
    ReferralCommission.deleteMany({
      $or: [
        { referrerUserId: { $in: deleteIds } },
        { referredUserId: { $in: deleteIds } }
      ]
    }),
    TradeJournal.deleteMany({ userId: { $in: deleteIdStrings } }),
    TradeExecution.deleteMany({ userId: { $in: deleteIdStrings } })
  ]);

  await UserConfig.updateMany(
    { _id: { $in: keepIds }, referredBy: { $in: deleteIds } },
    { $set: { referredBy: null, referredAt: null } }
  );

  await UserConfig.updateMany({ email: { $in: adminEmails } }, { $set: { role: 'admin' } });

  const deletedUsers = await UserConfig.deleteMany({ _id: { $in: deleteIds } });
  const remaining = await UserConfig.find().select('email role').lean();

  console.log(
    JSON.stringify(
      {
        deletedUsers: deletedUsers.deletedCount,
        deletedPayments: payments.deletedCount,
        deletedReferrals: referrals.deletedCount,
        deletedJournals: journals.deletedCount,
        deletedExecutions: executions.deletedCount,
        totalUsersAfter: remaining.length,
        remaining: remaining.map((u) => ({ email: u.email, role: u.role }))
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('purge failed:', err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
