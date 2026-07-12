const express = require('express');
const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const devUserStore = require('../utils/devUserStore');
const { hashPassword, comparePassword, signToken, sanitizeUser } = require('../utils/auth');
const requireAuth = require('../middleware/requireAuth');
const validateRequest = require('../middleware/validate');
const { registerValidators, loginValidators } = require('../validators/authValidators');

const router = express.Router();

async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (mongoose.connection.readyState !== 1) {
    return devUserStore.findByEmail(normalized);
  }
  try {
    return await UserConfig.findOne({ email: normalized });
  } catch {
    return devUserStore.findByEmail(normalized);
  }
}

async function createUserRecord({ email, passwordHash, displayName, phone }) {
  const subscription = {
    tier: 'basic',
    status: 'inactive',
    createdAt: new Date(),
    updatedAt: new Date()
  };

  if (mongoose.connection.readyState !== 1) {
    return devUserStore.createUser({ email, passwordHash, displayName, phone, subscription });
  }
  try {
    const user = new UserConfig({
      email,
      passwordHash,
      displayName: displayName || email.split('@')[0],
      phone,
      subscription
    });
    return user.save();
  } catch (error) {
    if (error.code === 11000) {
      throw Object.assign(new Error('Email already registered.'), { status: 409 });
    }
    return devUserStore.createUser({ email, passwordHash, displayName, phone, subscription });
  }
}

router.post('/register', registerValidators, validateRequest, async (req, res) => {
  try {
    const { email, password, displayName, phone } = req.body;

    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const passwordHash = await hashPassword(password);
    const user = await createUserRecord({ email, passwordHash, displayName, phone });
    const token = signToken(user);

    return res.status(201).json({
      message: 'Account created successfully.',
      token,
      user: sanitizeUser(user)
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      message: error.message || 'Unable to create account.'
    });
  }
});

router.post('/login', loginValidators, validateRequest, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await findUserByEmail(email);

    if (!user || !user.passwordHash) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const valid = await comparePassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const token = signToken(user);
    return res.json({
      message: 'Signed in successfully.',
      token,
      user: sanitizeUser(user)
    });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to sign in.', error: error.message });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

module.exports = router;
