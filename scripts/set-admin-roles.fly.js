/**
 * Align production admin roles:
 * - Only allowlisted SUPER_ADMIN_EMAILS get role super_admin (default: collinspark1985@gmail.com)
 * - Other known operators stay/get role admin
 * - Anyone else with role super_admin is demoted to admin
 *
 * Run on Fly:
 *   flyctl ssh console -a kaching-api -C "node /app/scripts/set-admin-roles.fly.js"
 */
const mongoose = require('/app/node_modules/mongoose');
const UserConfig = require('/app/models/User');
const {
  DEFAULT_SUPER_ADMIN_EMAIL,
  parseSuperAdminEmails,
  parseAdminEmails
} = require('/app/utils/adminAccess');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  const superEmails = parseSuperAdminEmails();
  const adminEmails = [
    ...new Set([
      ...parseAdminEmails().filter(email => !superEmails.includes(email)),
      // Known operators who should remain general admins (not super).
      'barasajohn1985@gmail.com',
      'lilianmonari15@gmail.com'
    ].map(email => String(email).trim().toLowerCase()).filter(Boolean))
  ].filter(email => !superEmails.includes(email));

  // Ensure canonical super admin(s).
  const promoted = await UserConfig.updateMany(
    { email: { $in: superEmails } },
    { $set: { role: 'super_admin' } }
  );

  // Demote every other super_admin (including former allowlist members).
  const demoted = await UserConfig.updateMany(
    { role: 'super_admin', email: { $nin: superEmails } },
    { $set: { role: 'admin' } }
  );

  // Re-affirm known general admins.
  if (adminEmails.length) {
    await UserConfig.updateMany({ email: { $in: adminEmails } }, { $set: { role: 'admin' } });
  }

  const superUsers = await UserConfig.find({ role: 'super_admin' }).select('email role').lean();
  const touched = await UserConfig.find({
    email: { $in: [...superEmails, ...adminEmails, DEFAULT_SUPER_ADMIN_EMAIL] }
  })
    .select('email role')
    .lean();

  console.log(
    JSON.stringify(
      {
        superAdminAllowlist: superEmails,
        promotedMatched: promoted.matchedCount ?? promoted.n,
        demotedMatched: demoted.matchedCount ?? demoted.n,
        demotedModified: demoted.modifiedCount ?? demoted.nModified,
        superAdminsAfter: superUsers,
        knownOperators: touched
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
})().catch(async e => {
  console.error(e.message);
  process.exit(1);
});
