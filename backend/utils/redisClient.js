const { createClient } = require('redis');

let client = null;
let connectPromise = null;
let redisUnavailable = false;

function isRedisEnabled() {
  const flag = String(process.env.REDIS_ENABLED ?? 'true').trim().toLowerCase();
  return flag !== 'false' && flag !== '0' && flag !== 'off';
}

async function getRedisClient() {
  if (!isRedisEnabled() || redisUnavailable) {
    return null;
  }

  if (client?.isOpen) {
    return client;
  }

  if (!connectPromise) {
    connectPromise = (async () => {
      const nextClient = createClient({
        url: process.env.REDIS_URL || 'redis://127.0.0.1:6379/0',
        socket: {
          connectTimeout: 2000,
          reconnectStrategy: false
        }
      });

      nextClient.on('error', () => {
        // Suppress repeated connection errors after initial failure.
      });

      await nextClient.connect();
      client = nextClient;
      return client;
    })().catch(error => {
      redisUnavailable = true;
      connectPromise = null;
      console.warn('[Redis] Unavailable, using in-memory market cache:', error.message);
      return null;
    });
  }

  return connectPromise;
}

module.exports = {
  getRedisClient,
  isRedisEnabled
};
