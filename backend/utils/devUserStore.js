const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

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

function upsertUser(id, patch) {
  const store = readStore();
  const key = String(id || '').trim();
  if (!key) return null;
  store[key] = {
    id: key,
    email: '',
    displayName: '',
    passwordHash: '',
    subscription: { status: 'inactive', tier: 'basic' },
    ...store[key],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  writeStore(store);
  return store[key];
}

function findById(id) {
  const store = readStore();
  return store[String(id || '').trim()] || null;
}

function findByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  const store = readStore();
  return Object.values(store).find(u => String(u.email || '').trim().toLowerCase() === normalized) || null;
}

function createUser({ email, passwordHash, displayName, phone, subscription }) {
  const id = randomUUID();
  return upsertUser(id, {
    id,
    email: String(email).trim().toLowerCase(),
    passwordHash,
    displayName: displayName || email.split('@')[0],
    phone: phone || '',
    subscription: subscription || { status: 'inactive', tier: 'basic' },
    createdAt: new Date().toISOString()
  });
}

function listActiveSubscribers() {
  const store = readStore();
  return Object.values(store);
}

module.exports = {
  upsertUser,
  findById,
  findByEmail,
  createUser,
  listActiveSubscribers
};
