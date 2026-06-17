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
    .withMessage('Phone must be a valid number (9–15 digits, optional + prefix).')
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

const subscribeValidators = [
  body('tier')
    .isIn(['basic', 'professional', 'premium'])
    .withMessage('Invalid subscription tier.'),
  body('provider')
    .isIn(['mpesa', 'paypal', 'mock'])
    .withMessage('Invalid payment provider.'),
  body('phone')
    .if(body('provider').equals('mpesa'))
    .trim()
    .matches(/^\+?[0-9]{9,15}$/)
    .withMessage('A valid phone number is required for M-Pesa.')
];

module.exports = {
  registerValidators,
  loginValidators,
  subscribeValidators
};
