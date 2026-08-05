/**
 * Purge obsolete Redis keys related to legacy MT5 LinkToken / old pairing formats.
 *
 * KEEP (current PairCode format):
 *   kaching:mt5:pair:code:*
 *   kaching:mt5:pair:user:*
 *   kaching:mt5:pair:fail:ip:*
 *   kaching:mt5:pair:fail:code:*
 *
 * PURGE (legacy / unused patterns — deleted if present):
 *   kaching:mt5:link:*
 *   kaching:mt5:linktoken:*
 *   kaching:mt5:link-token:*
 *   mt5:link:*
 *   mt5:linktoken:*
 *   mt5:linkToken:*
 *
 * Usage:
 *   CONFIRM_PURGE=YES node scripts/purge-mt5-legacy-redis.js
 * Dry-run (default): lists matching keys only.
 */
const { createClient } = require('redis');

const PURGE_PATTERNS = [
  'kaching:mt5:link:*',
  'kaching:mt5:linktoken:*',
  'kaching:mt5:link-token:*',
  'kaching:mt5:linkToken:*',
  'mt5:link:*',
  'mt5:linktoken:*',
  'mt5:link-token:*',
  'mt5:linkToken:*'
];

const KEEP_PREFIXES = [
  'kaching:mt5:pair:code:',
  'kaching:mt5:pair:user:',
  'kaching:mt5:pair:fail:ip:',
  'kaching:mt5:pair:fail:code:'
];

async function scanKeys(redis, pattern) {
  const found = [];
  for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
    found.push(key);
  }
  return found;
}

async function main() {
  const confirm = process.env.CONFIRM_PURGE === 'YES';
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379/0';

  const redis = createClient({
    url,
    socket: {
      connectTimeout: 10000,
      tls: String(url).startsWith('rediss://') || undefined
    }
  });
  redis.on('error', (err) => console.error('[Redis]', err.message));
  await redis.connect();

  const report = { mode: confirm ? 'PURGE' : 'DRY_RUN', patterns: {}, deleted: 0, keptPrefixes: KEEP_PREFIXES };

  for (const pattern of PURGE_PATTERNS) {
    const keys = await scanKeys(redis, pattern);
    report.patterns[pattern] = keys.length;
    if (keys.length && confirm) {
      // Batch delete
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        await redis.del(chunk);
        report.deleted += chunk.length;
      }
    } else if (keys.length) {
      report.sample = report.sample || {};
      report.sample[pattern] = keys.slice(0, 10);
    }
  }

  // Sanity: count current pair keys (never deleted by this script)
  let pairCodeCount = 0;
  for await (const _ of redis.scanIterator({ MATCH: 'kaching:mt5:pair:code:*', COUNT: 200 })) {
    pairCodeCount += 1;
  }
  report.currentPairCodeKeys = pairCodeCount;

  console.log(JSON.stringify(report, null, 2));
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
