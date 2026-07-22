const express = require('express');
const mongoose = require('mongoose');
const UserConfig = require('../models/User');
const devUserStore = require('../utils/devUserStore');
const { hashPassword, comparePassword, signToken, sanitizeUser } = require('../utils/auth');
const { setAuthCookie, clearAuthCookie } = require('../utils/sessionCookies');
const { isAdmin } = require('../utils/adminAccess');
const { generateToken, hashToken, verificationExpiry, resetExpiry } = require('../utils/emailTokens');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/mailer');
const { isBetaMode, getBetaSubscription } = require('../utils/betaMode');
const requireAuth = require('../middleware/requireAuth');
const validateRequest = require('../middleware/validate');
const {
  registerValidators,
  loginValidators,
  forgotPasswordValidators,
  resetPasswordValidators,
  verifyEmailValidators,
  resendVerificationValidators
} = require('../validators/authValidators');

const router = express.Router();

const GENERIC_RESET_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

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

async function findUserByVerificationToken(token) {
  const hashed = hashToken(token);
  if (mongoose.connection.readyState !== 1) {
    return devUserStore.findByHashedToken('emailVerification', hashed);
  }
  try {
    return await UserConfig.findOne({ emailVerificationToken: hashed });
  } catch {
    return devUserStore.findByHashedToken('emailVerification', hashed);
  }
}

async function findUserByResetToken(token) {
  const hashed = hashToken(token);
  if (mongoose.connection.readyState !== 1) {
    return devUserStore.findByHashedToken('passwordReset', hashed);
  }
  try {
    return await UserConfig.findOne({ passwordResetToken: hashed });
  } catch {
    return devUserStore.findByHashedToken('passwordReset', hashed);
  }
}

async function updateUserRecord(user, patch) {
  const userId = user._id?.toString() || user.id;
  if (mongoose.connection.readyState !== 1 || !user._id) {
    return devUserStore.upsertUser(userId, patch);
  }
  try {
    return await UserConfig.findByIdAndUpdate(userId, { ...patch, updatedAt: new Date() }, { new: true });
  } catch {
    return devUserStore.upsertUser(userId, patch);
  }
}

async function createUserRecord({
  email,
  passwordHash,
  displayName,
  phone,
  emailVerified,
  emailVerificationToken,
  emailVerificationExpiresAt,
  subscription
}) {
  const defaultSubscription = {
    tier: 'basic',
    status: 'inactive',
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const resolvedSubscription = subscription || defaultSubscription;

  if (mongoose.connection.readyState !== 1) {
    return devUserStore.createUser({
      email,
      passwordHash,
      displayName,
      phone,
      subscription: resolvedSubscription,
      emailVerified,
      emailVerificationToken,
      emailVerificationExpiresAt
    });
  }
  try {
    const user = new UserConfig({
      email,
      passwordHash,
      displayName: displayName || email.split('@')[0],
      phone,
      subscription: resolvedSubscription,
      emailVerified: emailVerified === true,
      emailVerificationToken,
      emailVerificationExpiresAt
    });
    return user.save();
  } catch (error) {
    if (error.code === 11000) {
      throw Object.assign(new Error('Email already registered.'), { status: 409 });
    }
    return devUserStore.createUser({
      email,
      passwordHash,
      displayName,
      phone,
      subscription: resolvedSubscription,
      emailVerified,
      emailVerificationToken,
      emailVerificationExpiresAt
    });
  }
}

function isUserVerified(user) {
  if (isAdmin(user)) return true;
  if (isBetaMode()) return true;
  return user.emailVerified !== false;
}

router.post('/register', registerValidators, validateRequest, async (req, res) => {
  try {
    const { email, password, displayName, phone, referralCode } = req.body;

    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    const passwordHash = await hashPassword(password);
    const beta = isBetaMode();
    const verificationToken = beta ? null : generateToken();

    const user = await createUserRecord({
      email,
      passwordHash,
      displayName,
      phone,
      emailVerified: beta,
      emailVerificationToken: verificationToken ? hashToken(verificationToken) : null,
      emailVerificationExpiresAt: verificationToken ? verificationExpiry() : null,
      subscription: beta ? getBetaSubscription() : undefined
    });

    try {
      const ReferralService = require('../services/ReferralService');
      await ReferralService.attributeReferralAtRegistration(user._id || user.id, referralCode);
    } catch (error) {
      console.warn('[Referral] Attribution failed:', error.message);
    }

    if (beta) {
      return sendAuthSession(res, user, 'Beta account created. You are signed in with full test access.');
    }

    if (verificationToken) {
      try {
        await sendVerificationEmail({
          to: email,
          token: verificationToken,
          displayName: user.displayName
        });
      } catch (mailError) {
        console.error('[auth] verification email failed:', mailError.message, mailError.body || '');
        return res.status(201).json({
          message:
            'Account created, but the verification email could not be sent. Tap Resend verification email, or contact support.',
          requiresVerification: true,
          email,
          emailDeliveryFailed: true
        });
      }
    }

    return res.status(201).json({
      message: 'Account created. Check your email to verify your address before signing in.',
      requiresVerification: true,
      email
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      message: error.message || 'Unable to create account.'
    });
  }
});

function sendAuthSession(res, user, message) {
  const token = signToken(user);
  setAuthCookie(res, token);
  return res.json({
    message,
    user: sanitizeUser(user)
  });
}

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

    if (!isUserVerified(user)) {
      return res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email address before signing in.',
        email: user.email
      });
    }

    return sendAuthSession(res, user, 'Signed in successfully.');
  } catch (error) {
    return res.status(500).json({ message: 'Unable to sign in.' });
  }
});

router.post('/forgot-password', forgotPasswordValidators, validateRequest, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await findUserByEmail(email);

    if (user) {
      const resetToken = generateToken();
      await updateUserRecord(user, {
        passwordResetToken: hashToken(resetToken),
        passwordResetExpiresAt: resetExpiry()
      });
      await sendPasswordResetEmail({
        to: user.email,
        token: resetToken,
        displayName: user.displayName
      });
    }

    return res.json({ message: GENERIC_RESET_MESSAGE });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to process password reset request.' });
  }
});

router.post('/reset-password', resetPasswordValidators, validateRequest, async (req, res) => {
  try {
    const { token, password } = req.body;
    const user = await findUserByResetToken(token);

    if (!user || !user.passwordResetExpiresAt || new Date(user.passwordResetExpiresAt) < new Date()) {
      return res.status(400).json({ message: 'This password reset link is invalid or has expired.' });
    }

    const passwordHash = await hashPassword(password);
    const updated = await updateUserRecord(user, {
      passwordHash,
      passwordResetToken: null,
      passwordResetExpiresAt: null
    });

    return sendAuthSession(res, updated, 'Password updated successfully.');
  } catch (error) {
    return res.status(500).json({ message: 'Unable to reset password.' });
  }
});

async function verifyEmailWithToken(token) {
  const user = await findUserByVerificationToken(token);
  if (!user || !user.emailVerificationExpiresAt || new Date(user.emailVerificationExpiresAt) < new Date()) {
    return { error: { status: 400, message: 'This verification link is invalid or has expired.' } };
  }

  const updated = await updateUserRecord(user, {
    emailVerified: true,
    emailVerificationToken: null,
    emailVerificationExpiresAt: null
  });

  return {
    message: 'Email verified successfully.',
    user: sanitizeUser(updated),
    token: signToken(updated)
  };
}

router.get('/verify-email', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.status(400).json({ message: 'Verification token is required.' });
  }

  try {
    const result = await verifyEmailWithToken(token);
    if (result.error) {
      return res.status(result.error.status).json({ message: result.error.message });
    }
    setAuthCookie(res, result.token);
    delete result.token;
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: 'Unable to verify email.' });
  }
});

router.post('/verify-email', verifyEmailValidators, validateRequest, async (req, res) => {
  try {
    const result = await verifyEmailWithToken(req.body.token);
    if (result.error) {
      return res.status(result.error.status).json({ message: result.error.message });
    }
    setAuthCookie(res, result.token);
    delete result.token;
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: 'Unable to verify email.' });
  }
});

router.post('/resend-verification', resendVerificationValidators, validateRequest, async (req, res) => {
  try {
    const { email } = req.body;
    const user = await findUserByEmail(email);

    if (!user || isUserVerified(user)) {
      return res.json({
        message: 'If an unverified account exists for that email, a verification link has been sent.'
      });
    }

    const verificationToken = generateToken();
    await updateUserRecord(user, {
      emailVerificationToken: hashToken(verificationToken),
      emailVerificationExpiresAt: verificationExpiry()
    });
    try {
      await sendVerificationEmail({
        to: user.email,
        token: verificationToken,
        displayName: user.displayName
      });
    } catch (mailError) {
      console.error('[auth] resend verification email failed:', mailError.message, mailError.body || '');
      return res.status(502).json({
        message: 'Unable to send verification email right now. Please try again in a moment.'
      });
    }

    return res.json({
      message: 'If an unverified account exists for that email, a verification link has been sent.'
    });
  } catch (error) {
    console.error('[auth] resend-verification error:', error.message);
    return res.status(500).json({ message: 'Unable to resend verification email.' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ message: 'Signed out successfully.' });
});

module.exports = router;
