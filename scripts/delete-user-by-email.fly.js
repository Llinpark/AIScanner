/* eslint-disable */
/**
 * Delete one user by email (and related user-scoped records) on Fly production.
 *
 * Env:
 *   TARGET_EMAIL=collinspark@hotmail.com
 *   CONFIRM_DELETE=YES
 *
 * Run:
 *   flyctl ssh console -a kaching-api -C "TARGET_EMAIL=... CONFIRM_DELETE=YES node /app/scripts/delete-user-by-email.fly.js"
 */
const mongoose = require('/app/node_modules/mongoose');
const UserConfig = require('/app/models/User');
const PaymentTransaction = require('/app/models/PaymentTransaction');
const ReferralCommission = require('/app/models/ReferralCommission');
const TradeJournal = require('/app/models/TradeJournal');
const TradeExecution = require('/app/models/TradeExecution');
const { parseAdminEmails } = require('/app/utils/adminAccess');

const PROTECTED_ADMIN_EMAILS = [
  'collinspark1985@gmail.com',
  'barasajohn1985@gmail.com',
  'lilianmonari15@gmail.com'
];

async function main() {
  if (process.env.CONFIRM_DELETE !== 'YES') {
    console.error('Refusing to run without CONFIRM_DELETE=YES');
    process.exit(1);
  }

  const targetEmail = String(process.env.TARGET_EMAIL || '')
    .trim()
    .toLowerCase();
  if (!targetEmail) {
    console.error('TARGET_EMAIL is required');
    process.exit(1);
  }

  const adminEmails = Array.from(
    new Set([
      ...PROTECTED_ADMIN_EMAILS.map((e) => e.toLowerCase()),
      ...parseAdminEmails().map((e) => String(e).toLowerCase())
    ])
  );

  if (adminEmails.includes(targetEmail)) {
    console.error(
      JSON.stringify({
        aborted: true,
        reason: 'Target email is a protected admin account',
        targetEmail,
        adminEmails
      })
    );
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  const beforeUser = await UserConfig.findOne({ email: targetEmail })
    .select('_id email role createdAt')
    .lean();

  if (!beforeUser) {
    console.log(
      JSON.stringify(
        {
          targetEmail,
          existed: false,
          deletedUsers: 0,
          deletedPayments: 0,
          deletedReferrals: 0,
          deletedJournals: 0,
          deletedExecutions: 0
        },
        null,
        2
      )
    );
    await mongoose.disconnect();
    return;
  }

  if (beforeUser.role === 'admin' || beforeUser.role === 'super_admin') {
    console.error(
      JSON.stringify({
        aborted: true,
        reason: 'Target user has admin role — refusing to delete',
        user: beforeUser
      })
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const deleteIds = [beforeUser._id];
  const deleteIdStrings = [String(beforeUser._id)];

  const relatedBefore = {
    payments: await PaymentTransaction.countDocuments({ userId: { $in: deleteIds } }),
    referrals: await ReferralCommission.countDocuments({
      $or: [
        { referrerUserId: { $in: deleteIds } },
        { referredUserId: { $in: deleteIds } }
      ]
    }),
    journals: await TradeJournal.countDocuments({ userId: { $in: deleteIdStrings } }),
    executions: await TradeExecution.countDocuments({ userId: { $in: deleteIdStrings } })
  };

  console.log(
    JSON.stringify(
      {
        before: {
          existed: true,
          user: beforeUser,
          relatedCounts: relatedBefore,
          totalUsersBefore: await UserConfig.countDocuments()
        }
      },
      null,
      2
    )
  );

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
    { referredBy: { $in: deleteIds } },
    { $set: { referredBy: null, referredAt: null } }
  );

  const deletedUsers = await UserConfig.deleteMany({ _id: { $in: deleteIds } });
  const afterUser = await UserConfig.findOne({ email: targetEmail }).select('_id email').lean();

  console.log(
    JSON.stringify(
      {
        after: {
          existed: Boolean(afterUser),
          deletedUsers: deletedUsers.deletedCount,
          deletedPayments: payments.deletedCount,
          deletedReferrals: referrals.deletedCount,
          deletedJournals: journals.deletedCount,
          deletedExecutions: executions.deletedCount,
          totalUsersAfter: await UserConfig.countDocuments(),
          adminsStillPresent: await UserConfig.find({
            email: { $in: PROTECTED_ADMIN_EMAILS }
          })
            .select('email role')
            .lean()
        }
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('delete-user failed:', err.message);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
