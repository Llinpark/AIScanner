const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const SALT_ROUNDS = 12;

async function hashPassword(password) {
  return bcrypt.hash(password, SALT_ROUNDS);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  const userId = user._id?.toString() || user.id;
  return jwt.sign({ userId, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function normalizeSubscription(subscription) {
  const sub = subscription || { status: 'inactive', tier: 'basic' };
  if (sub.status === 'trial') {
    return { ...sub, status: 'inactive', trialEnds: undefined };
  }
  const { trialEnds, ...rest } = sub;
  return rest;
}

const { isAdmin } = require('./adminAccess');

function sanitizeUser(user) {
  const obj = user.toObject ? user.toObject() : { ...user };
  delete obj.passwordHash;
  const role = obj.role || 'user';
  return {
    id: obj._id?.toString() || obj.id,
    email: obj.email,
    displayName: obj.displayName,
    phone: obj.phone,
    role,
    isAdmin: isAdmin(obj),
    subscription: normalizeSubscription(obj.subscription),
    createdAt: obj.createdAt
  };
}

module.exports = {
  hashPassword,
  comparePassword,
  signToken,
  verifyToken,
  sanitizeUser,
  JWT_SECRET
};
