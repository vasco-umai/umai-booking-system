const rateLimit = require('express-rate-limit');

// Login: 5 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.', code: 'RATE_LIMITED' },
});

// Forgot password: 3 per hour per IP
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password reset requests. Please try again later.', code: 'RATE_LIMITED' },
});

// Bookings: 10 per minute per IP
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many booking requests. Please slow down.', code: 'RATE_LIMITED' },
});

// Availability: 60 per minute per IP
const availabilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' },
});

// Registration: 5 per hour per IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Please try again later.', code: 'RATE_LIMITED' },
});

// Check email: 10 per 15 minutes per IP
const checkEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
});

module.exports = {
  loginLimiter,
  forgotPasswordLimiter,
  bookingLimiter,
  availabilityLimiter,
  registerLimiter,
  checkEmailLimiter,
};
