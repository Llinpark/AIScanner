const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'dev-journal.json');

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeStore(entries) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

function listByUser(userId) {
  return readStore().filter(e => e.userId === String(userId));
}

function findById(id, userId) {
  return readStore().find(e => e._id === id && e.userId === String(userId)) || null;
}

function create(userId, payload) {
  const entries = readStore();
  const entry = {
    _id: randomUUID(),
    userId: String(userId),
    ...payload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  entries.unshift(entry);
  writeStore(entries);
  return entry;
}

function update(id, userId, patch) {
  const entries = readStore();
  const idx = entries.findIndex(e => e._id === id && e.userId === String(userId));
  if (idx === -1) return null;
  entries[idx] = {
    ...entries[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  writeStore(entries);
  return entries[idx];
}

function remove(id, userId) {
  const entries = readStore();
  const next = entries.filter(e => !(e._id === id && e.userId === String(userId)));
  if (next.length === entries.length) return false;
  writeStore(next);
  return true;
}

module.exports = {
  listByUser,
  findById,
  create,
  update,
  remove
};
