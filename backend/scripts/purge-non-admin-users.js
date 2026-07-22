/**
 * Delete all users except admins (ADMIN_EMAILS + role=admin).
 * Also removes user-scoped payments, referrals, journals, and executions.
 *
 * Usage: node scripts/purge-non-admin-users.js
 * Optional: CONFIRM_PURGE=YES node scripts/purge-non-admin-users.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const PaymentTransaction = require('../models/PaymentTransaction');
const ReferralCommission = require('../models/ReferralCommission');
const TradeJournal = require('../models/TradeJournal');
const TradeExecution = require('../models/TradeExecution');
const { parseAdminEmails } = require('../utils/adminAccess');

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
    console.error('ADMIN_EMAILS is empty — aborting to avoid deleting everyone');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  const keepFilter = {
    $or: [{ email: { $in: adminEmails } }, { role: 'admin' }]
  };

  const keepUsers = await UserConfig.find(keepFilter).select('_id email role').lean();
  const keepIds = keepUsers.map(u => u._id);
  const keepIdStrings = keepIds.map(id => String(id));

  const totalBefore = await UserConfig.countDocuments();
  const deleteFilter = { _id: { $nin: keepIds } };
  const toDelete = await UserConfig.find(deleteFilter).select('_id email').lean();
  const deleteIds = toDelete.map(u => u._id);
  const deleteIdStrings = deleteIds.map(id => String(id));

  console.log(
    JSON.stringify(
      {
        adminEmails,
        totalUsersBefore: totalBefore,
        keeping: keepUsers.map(u => ({ email: u.email, role: u.role })),
        deletingCount: toDelete.length,
        deletingSample: toDelete.slice(0, 20).map(u => u.email)
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

  // Ensure kept admin emails have role=admin
  await UserConfig.updateMany(
    { email: { $in: adminEmails } },
    { $set: { role: 'admin' } }
  );

  const deletedUsers = await UserConfig.deleteMany(deleteFilter);
  const totalAfter = await UserConfig.countDocuments();

  console.log(
    JSON.stringify(
      {
        deletedUsers: deletedUsers.deletedCount,
        deletedPayments: payments.deletedCount,
        deletedReferrals: referrals.deletedCount,
        deletedJournals: journals.deletedCount,
        deletedExecutions: executions.deletedCount,
        totalUsersAfter: totalAfter,
        remaining: (await UserConfig.find().select('email role').lean()).map(u => ({
          email: u.email,
          role: u.role
        }))
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch(async err => {
  console.error('purge failed:', err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
