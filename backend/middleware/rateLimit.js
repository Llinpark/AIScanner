function clientKey(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter({ windowMs = 60_000, max = 60, keyGenerator = clientKey, message } = {}) {
  const hits = new Map();

  return (req, res, next) => {
    const key = keyGenerator(req);
    const now = Date.now();
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

const globalApiLimiter = createRateLimiter({ windowMs: 60_000, max: 300 });
const authLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 30,
  message: 'Too many authentication attempts. Please wait and try again.'
});
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

module.exports = {
  createRateLimiter,
  globalApiLimiter,
  authLimiter,
  webhookLimiter,
  scannerLimiter
};
