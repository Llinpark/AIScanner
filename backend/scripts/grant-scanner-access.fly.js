/**
 * Grant Scanner (super_admin) access to a user by email.
 * Only emails on SUPER_ADMIN_EMAILS (or the default canonical email) may be promoted.
 *
 * Run on Fly:
 *   GRANT_SCANNER_EMAIL=collinspark1985@gmail.com flyctl ssh console -a kaching-api -C "node /app/scripts/grant-scanner-access.fly.js"
 */
const mongoose = require('/app/node_modules/mongoose');
const UserConfig = require('/app/models/User');
const { parseSuperAdminEmails, DEFAULT_SUPER_ADMIN_EMAIL } = require('/app/utils/adminAccess');

const EMAIL = (
  process.env.GRANT_SCANNER_EMAIL || DEFAULT_SUPER_ADMIN_EMAIL
)
  .trim()
  .toLowerCase();

(async () => {
  const allowlist = parseSuperAdminEmails();
  if (!allowlist.includes(EMAIL)) {
    console.error(
      JSON.stringify({
        refused: true,
        email: EMAIL,
        reason: 'Email is not on SUPER_ADMIN_EMAILS allowlist',
        allowlist
      })
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  const before = await UserConfig.findOne({ email: EMAIL }).select('email role').lean();
  if (!before) {
    console.error(`USER_NOT_FOUND: ${EMAIL}`);
    process.exit(1);
  }

  const after = await UserConfig.findOneAndUpdate(
    { email: EMAIL },
    { $set: { role: 'super_admin' } },
    { new: true }
  )
    .select('email role')
    .lean();

  console.log(JSON.stringify({ before, after, allowlist }, null, 2));
  await mongoose.disconnect();
})().catch(async e => {
  console.error(e.message || e);
  process.exit(1);
});
