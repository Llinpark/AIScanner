'use strict';

/**
 * Diagnostics / reconnect helper. Never used as Redis claim authority.
 * Unrefs the timer so a hung op cannot keep the process (or tests) alive.
 */
function withTimeout(promise, ms, label = 'operation') {
  const timeoutMs = Number(ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label}_timeout`);
      err.reason = 'timeout';
      err.code = 'DIAG_TIMEOUT';
      reject(err);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

module.exports = { withTimeout };
