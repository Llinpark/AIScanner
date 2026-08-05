/**
 * One-off / safe migration: unset obsolete MT5 LinkToken fields from UserConfig.
 *
 * Keeps:
 *   - mt5.devices[] (active PairCode multi-device auth)
 *   - telegram.linkCode / telegram.linkCodeExpiresAt (Telegram linking — unrelated)
 *
 * Removes (when present):
 *   - mt5.linkToken
 *   - any other documented legacy MT5 link-only fields listed below
 *
 * Usage (local / Atlas URI):
 *   CONFIRM_PURGE=YES node scripts/purge-mt5-linktoken.js
 *
 * Usage (Fly machine, after deploy):
 *   fly ssh console -a kaching-api -C "node /app/scripts/purge-mt5-linktoken.fly.js"
 *
 * Dry-run (default without CONFIRM_PURGE=YES): counts only.
 */
const mongoose = require('mongoose');

const LEGACY_UNSET = {
  'mt5.linkToken': ''
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  const confirm = process.env.CONFIRM_PURGE === 'YES';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const col = mongoose.connection.collection('userconfigs');

  const withLinkToken = await col.countDocuments({
    'mt5.linkToken': { $exists: true, $ne: null }
  });
  const withLinkTokenEmpty = await col.countDocuments({
    'mt5.linkToken': { $exists: true, $eq: null }
  });
  const withDevices = await col.countDocuments({
    'mt5.devices.0': { $exists: true }
  });

  console.log(
    JSON.stringify(
      {
        mode: confirm ? 'PURGE' : 'DRY_RUN',
        usersWithMt5LinkToken: withLinkToken,
        usersWithNullLinkTokenField: withLinkTokenEmpty,
        usersWithMt5Devices: withDevices,
        fieldsToUnset: Object.keys(LEGACY_UNSET),
        note: 'telegram.linkCode is NOT touched'
      },
      null,
      2
    )
  );

  if (!confirm) {
    console.log('Dry-run only. Re-run with CONFIRM_PURGE=YES to apply $unset.');
    await mongoose.disconnect();
    return;
  }

  const result = await col.updateMany(
    { 'mt5.linkToken': { $exists: true } },
    { $unset: LEGACY_UNSET }
  );

  console.log(
    JSON.stringify(
      {
        matched: result.matchedCount,
        modified: result.modifiedCount,
        acknowledged: result.acknowledged
      },
      null,
      2
    )
  );

  // Ensure device-token indexes exist (schema indexes may lag until next app boot).
  try {
    await col.createIndex({ 'mt5.devices.accessToken': 1 }, { sparse: true, name: 'mt5_devices_accessToken_sparse' });
    await col.createIndex({ 'mt5.devices.refreshToken': 1 }, { sparse: true, name: 'mt5_devices_refreshToken_sparse' });
    await col.createIndex({ 'mt5.devices.deviceId': 1 }, { sparse: true, name: 'mt5_devices_deviceId_sparse' });
    console.log('Mongo indexes ensured for mt5.devices.{accessToken,refreshToken,deviceId}');
  } catch (err) {
    console.warn('Index ensure warning:', err.message);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
