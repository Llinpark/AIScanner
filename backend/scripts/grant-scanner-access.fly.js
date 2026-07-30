/**
 * Grant Scanner (super_admin) access to a user by email.
 *
 * Run on Fly:
 *   flyctl ssh console -a kaching-api -C "node /app/scripts/grant-scanner-access.fly.js"
 */
const mongoose = require('/app/node_modules/mongoose');
const UserConfig = require('/app/models/User');

const EMAIL = (process.env.GRANT_SCANNER_EMAIL || 'barasajohn1985@gmail.com').trim().toLowerCase();

(async () => {
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

  console.log(JSON.stringify({ before, after }, null, 2));
  await mongoose.disconnect();
})().catch(async e => {
  console.error(e.message || e);
  process.exit(1);
});
