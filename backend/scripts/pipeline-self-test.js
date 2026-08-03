#!/usr/bin/env node
/**
 * Dev-only CLI: exercise the real TradingView webhook → auth → validate → Mongo → delivery path.
 *
 * Usage (from backend/):
 *   ENABLE_PIPELINE_SELF_TEST=true node scripts/pipeline-self-test.js
 *   ENABLE_PIPELINE_SELF_TEST=true node scripts/pipeline-self-test.js --http
 *   ENABLE_PIPELINE_SELF_TEST=true node scripts/pipeline-self-test.js --in-process
 *
 * Default: local Express harness POST /api/webhook/tradingview (production auth+publish).
 * --http posts to a running server (PUBLIC_BACKEND_URL or http://127.0.0.1:4000).
 * --in-process calls production service functions without HTTP.
 */

require('dotenv').config();

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to run pipeline self-test in production');
  process.exit(1);
}

process.env.ENABLE_PIPELINE_SELF_TEST = process.env.ENABLE_PIPELINE_SELF_TEST || 'true';

const { runPipelineSelfTest } = require('../utils/pipelineSelfTest');

async function main() {
  const httpMode = process.argv.includes('--http');
  const inProcessOnly = process.argv.includes('--in-process');
  console.log(
    `[PipelineSelfTest] starting mode=${httpMode ? 'http' : inProcessOnly ? 'in_process' : 'http_harness'}`
  );

  const report = await runPipelineSelfTest({
    http: httpMode,
    inProcessOnly,
    baseUrl: process.env.PUBLIC_BACKEND_URL || 'http://127.0.0.1:4000',
    inMemorySignals: []
  });

  console.log(JSON.stringify(report, null, 2));
  // Force exit — mongoose/socket handles can keep the event loop alive.
  process.exit(report.ok ? 0 : 1);
}

main().catch(err => {
  console.error('[PipelineSelfTest] fatal:', err);
  process.exit(1);
});
