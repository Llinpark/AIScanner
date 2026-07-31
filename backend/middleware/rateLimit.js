function clientKey(req) {
  return (
    req.headers['fly-client-ip'] ||
    (String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() ||
    req.ip ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * In-memory sliding-window limiter with periodic stale-bucket cleanup.
 * Fine for single-machine Fly VMs; Redis-backed limits are a follow-up for multi-node.
 */
function createRateLimiter({ windowMs = 60_000, max = 60, keyGenerator = clientKey, message } = {}) {
  const hits = new Map();
  const CLEANUP_EVERY = Math.max(windowMs, 60_000);

  let lastCleanup = Date.now();
  function maybeCleanup(now) {
    if (now - lastCleanup < CLEANUP_EVERY) return;
    lastCleanup = now;
    for (const [key, bucket] of hits.entries()) {
      if (now - bucket.start >= windowMs) hits.delete(key);
    }
  }

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
    maybeCleanup(now);
    let bucket = hits.get(key);

    if (!bucket || now - bucket.start >= windowMs) {
      bucket = { start: now, count: 0 };
      hits.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({
        message: message || 'Too many requests. Please try again later.'
      });
    }

    return next();
  };
}

/**
 * Tracks only failed auth attempts (e.g. invalid TradingView licenseToken).
 * Call check() before verify; recordFailure() after a rejected auth.
 */
function createAuthFailureTracker({
  windowMs = 5 * 60_000,
  maxFailures = 25,
  message = 'Too many invalid authentication attempts. Please try again later.'
} = {}) {
  const hits = new Map();

  function prune(now) {
    for (const [key, bucket] of hits.entries()) {
      if (now - bucket.start >= windowMs) hits.delete(key);
    }
  }

  return {
    check(req, res) {
      const key = clientKey(req);
      const now = Date.now();
      prune(now);
      const bucket = hits.get(key);
      if (bucket && now - bucket.start < windowMs && bucket.count >= maxFailures) {
        res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
        res.status(429).json({ message });
        return false;
      }
      return true;
    },
    recordFailure(req) {
      const key = clientKey(req);
      const now = Date.now();
      let bucket = hits.get(key);
      if (!bucket || now - bucket.start >= windowMs) {
        bucket = { start: now, count: 0 };
        hits.set(key, bucket);
      }
      bucket.count += 1;
    }
  };
}

const globalApiLimiter = createRateLimiter({ windowMs: 60_000, max: 300 });

/** Login / register credential attempts (IP-scoped). */
const authAttemptLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 30,
  message: 'Too many authentication attempts. Please wait and try again.'
});

/** Password-reset + resend-verification email sends (IP-scoped, separate bucket). */
const authEmailLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 10,
  message: 'Too many email requests. Please wait and try again.'
});

/**
 * Token redeem endpoints (verify-email, reset-password).
 * Separate from login/register so failed sign-in /me traffic cannot block verification.
 */
const authTokenLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 20,
  message: 'Too many verification attempts. Please wait and try again.'
});

/** @deprecated Use authAttemptLimiter; kept for callers that still import authLimiter. */
const authLimiter = authAttemptLimiter;

const webhookLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 120,
  message: 'Webhook rate limit exceeded.'
});
const scannerLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 40,
  message: 'Scanner rate limit exceeded.'
});
const tradingViewAuthFailureTracker = createAuthFailureTracker({
  windowMs: 5 * 60_000,
  maxFailures: 20,
  message: 'Too many invalid TradingView webhook auth attempts.'
});

module.exports = {
  createRateLimiter,
  createAuthFailureTracker,
  clientKey,
  globalApiLimiter,
  authLimiter,
  authAttemptLimiter,
  authEmailLimiter,
  authTokenLimiter,
  webhookLimiter,
  scannerLimiter,
  tradingViewAuthFailureTracker
};
