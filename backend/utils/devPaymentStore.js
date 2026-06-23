const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'dev-payments.json');

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

function createTransaction({ userId, tier, provider, amount, currency, providerReference, merchantRequestId }) {
  const store = readStore();
  const id = randomUUID();
  const record = {
    id,
    userId: String(userId),
    tier,
    provider,
    amount,
    currency,
    providerReference,
    merchantRequestId,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  store[id] = record;
  if (providerReference) {
    store[`ref:${provider}:${providerReference}`] = id;
  }
  writeStore(store);
  return record;
}

function findByReference(providerReference, provider, userId) {
  const store = readStore();
  const id = store[`ref:${provider}:${providerReference}`];
  if (!id) return null;
  const record = store[id];
  if (!record) return null;
  if (userId && record.userId !== String(userId)) return null;
  return record;
}

function completeTransaction(providerReference, provider, { rawPayload, failureReason } = {}) {
  const store = readStore();
  const id = store[`ref:${provider}:${providerReference}`];
  if (!id || !store[id]) return null;

  store[id] = {
    ...store[id],
    status: failureReason ? 'failed' : 'completed',
    failureReason,
    rawPayload,
    completedAt: new Date().toISOString()
  };
  writeStore(store);
  return store[id];
}

module.exports = {
  createTransaction,
  findByReference,
  completeTransaction
};
