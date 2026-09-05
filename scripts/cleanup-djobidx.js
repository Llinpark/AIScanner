/**
 * Bounded cleanup of Redis hash kaching:trade:djobidx.
 *
 * Default is DRY-RUN. Does not run on application startup.
 *
 * Never materializes the whole hash, never enumerates all Redis keys,
 * and never flushes the Redis database or deletes the whole index key.
 *
 * Usage:
 *   node scripts/cleanup-djobidx.js
 *   node scripts/cleanup-djobidx.js --max-batches=20 --batch-size=100
 *   CONFIRM_DJOBIDX_CLEANUP=YES node scripts/cleanup-djobidx.js --execute
 *
 * Resume: pass --cursor=<hscan cursor> from the previous JSON report.
 * Interrupted runs are safe: only proven terminal/orphan members are HDEL'd.
 */
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const DurableDelivery = require('../utils/durableDelivery');

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(prefix));
  if (!hit) return fallback;
  if (hit === `--${name}`) return true;
  return hit.slice(prefix.length);
}

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

async function connectMongo() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.warn('[cleanup-djobidx] MONGODB_URI missing; Mongo classification unavailable');
    return false;
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  return mongoose.connection.readyState === 1;
}

async function main() {
  const executeRequested = process.argv.includes('--execute');
  const confirmed =
    String(process.env.CONFIRM_DJOBIDX_CLEANUP || '').trim().toUpperCase() === 'YES';
  const execute = executeRequested && confirmed;
  if (executeRequested && !confirmed) {
    console.error(
      '[cleanup-djobidx] --execute requires CONFIRM_DJOBIDX_CLEANUP=YES (refusing deletion)'
    );
    process.exitCode = 2;
    return;
  }

  const maxBatches = parsePositiveInt(argValue('max-batches'), 10);
  const batchSize = parsePositiveInt(argValue('batch-size'), 100);
  const maxHdel = parsePositiveInt(argValue('max-hdel'), 50);
  const cursor = String(argValue('cursor', '0'));

  const mongoOk = await connectMongo();
  if (execute && !mongoOk) {
    console.error('[cleanup-djobidx] EXECUTE refused: Mongo is required to prove members are stale');
    process.exitCode = 2;
    return;
  }

  let batchNo = 0;
  const report = await DurableDelivery.runIndexCleanupPass({
    cursor,
    count: batchSize,
    maxBatches,
    maxHdel,
    execute,
    onBatch(batch) {
      batchNo += 1;
      console.log(
        `[cleanup-djobidx] batch=${batchNo} scanned=${batch.scanned} ` +
          `terminal=${batch.terminal} missingFromMongo=${batch.missingFromMongo} ` +
          `wouldDelete=${batch.wouldDelete} deleted=${batch.deleted} ` +
          `preserved=${batch.preserved} cursor=${batch.cursor}`
      );
    }
  });

  const out = {
    ...report,
    executeRequested,
    confirmed,
    mongoConnected: mongoOk,
    resumeCursor: report.cursor,
    hint: report.done
      ? 'full pass complete (HSCAN cursor returned to 0)'
      : `re-run with --cursor=${report.cursor} to continue`
  };
  console.log(JSON.stringify(out, null, 2));

  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  try {
    const { shutdownRedis } = require('../utils/redisClient');
    shutdownRedis('cleanup-djobidx');
  } catch {
    /* ignore */
  }
}

main().catch(err => {
  console.error('[cleanup-djobidx] failed:', err && err.message ? err.message : err);
  process.exit(1);
});
