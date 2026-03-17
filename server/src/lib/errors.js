// Structured error codes for the API
const ErrorCodes = {
  // Auth
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  MUST_SET_PASSWORD: 'MUST_SET_PASSWORD',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  ACCOUNT_EXISTS: 'ACCOUNT_EXISTS',

  // Validation
  MISSING_FIELDS: 'MISSING_FIELDS',
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_DATE: 'INVALID_DATE',
  INVALID_INPUT: 'INVALID_INPUT',

  // Booking
  SLOT_CONFLICT: 'SLOT_CONFLICT',
  SLOT_IN_PAST: 'SLOT_IN_PAST',
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',

  // Calendar
  CALENDAR_FAILED: 'CALENDAR_FAILED',
  CALENDAR_SYNC_FAILED: 'CALENDAR_SYNC_FAILED',

  // Email
  EMAIL_FAILED: 'EMAIL_FAILED',

  // General
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

class AppError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code || ErrorCodes.INTERNAL_ERROR;
    this.details = details;
  }
}

module.exports = { ErrorCodes, AppError };
