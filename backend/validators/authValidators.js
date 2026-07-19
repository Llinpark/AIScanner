const { body } = require('express-validator');

const registerValidators = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('A valid email address is required.')
    .normalizeEmail(),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters.')
    .matches(/[A-Za-z]/)
    .withMessage('Password must contain at least one letter.')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number.'),
  body('displayName')
    .optional()
    .trim()
    .isLength({ min: 2, max: 60 })
    .withMessage('Display name must be between 2 and 60 characters.'),
  body('phone')
    .optional()
    .trim()
    .matches(/^\+?[0-9]{9,15}$/)
    .withMessage('Phone must be a valid number (9–15 digits, optional + prefix).'),
  body('referralCode')
    .optional()
    .trim()
    .isLength({ min: 4, max: 32 })
    .withMessage('Referral code must be between 4 and 32 characters.')
];

const loginValidators = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('A valid email address is required.')
    .normalizeEmail(),
  body('password')
    .notEmpty()
    .withMessage('Password is required.')
];

const forgotPasswordValidators = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('A valid email address is required.')
    .normalizeEmail()
];

const resetPasswordValidators = [
  body('token')
    .trim()
    .notEmpty()
    .withMessage('Reset token is required.'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters.')
    .matches(/[A-Za-z]/)
    .withMessage('Password must contain at least one letter.')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number.')
];

const verifyEmailValidators = [
  body('token')
    .trim()
    .notEmpty()
    .withMessage('Verification token is required.')
];

const resendVerificationValidators = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('A valid email address is required.')
    .normalizeEmail()
];

const subscribeValidators = [
  body('tier')
    .isIn(['basic', 'professional', 'premium'])
    .withMessage('Invalid subscription tier.'),
  body('provider')
    .isIn(['mpesa', 'paypal', 'mock', 'binance', 'sasapay'])
    .withMessage('Invalid payment provider.'),
  body('phone')
    .if(body('provider').isIn(['mpesa', 'sasapay']))
    .trim()
    .matches(/^\+?[0-9]{9,15}$/)
    .withMessage('A valid phone number is required for M-Pesa.'),
  body('billingCycle')
    .optional()
    .isIn(['weekly', 'monthly'])
    .withMessage('billingCycle must be weekly or monthly.')
];

module.exports = {
  registerValidators,
  loginValidators,
  forgotPasswordValidators,
  resetPasswordValidators,
  verifyEmailValidators,
  resendVerificationValidators,
  subscribeValidators
};
