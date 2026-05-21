const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'dev-users.json');

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function upsertUser(username, patch) {
  const store = readStore();
  const key = String(username || '').trim();
  if (!key) return null;
  store[key] = {
    username: key,
    tradingviewUsername: '',
    subscription: { status: 'inactive', tier: 'basic' },
    ...store[key],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  writeStore(store);
  return store[key];
}

function findByUsername(username) {
  const store = readStore();
  return store[String(username || '').trim()] || null;
}

function findByTradingViewUsername(tradingviewUsername) {
  const normalized = String(tradingviewUsername || '').trim().toLowerCase();
  if (!normalized) return null;
  const store = readStore();
  return Object.values(store).find(
    u => String(u.tradingviewUsername || '').trim().toLowerCase() === normalized
  ) || null;
}

function listSubscribers() {
  const store = readStore();
  return Object.values(store).filter(u => u.tradingviewUsername);
}

module.exports = {
  upsertUser,
  findByUsername,
  findByTradingViewUsername,
  listSubscribers
};
