// Input validation and sanitization utilities

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_REGEX.test(email) && email.length <= 254;
}

function isStrongPassword(password) {
  if (typeof password !== 'string' || password.length < 8) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return true;
}

function isValidISODate(str) {
  return typeof str === 'string' && ISO_DATE_REGEX.test(str);
}

// Strip HTML tags to prevent XSS in emails/calendar events
function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
}

// Sanitize an object's string values (strip HTML)
function sanitizeStrings(obj, keys) {
  const result = { ...obj };
  for (const key of keys) {
    if (typeof result[key] === 'string') {
      result[key] = stripHtml(result[key]);
    }
  }
  return result;
}

module.exports = {
  isValidEmail,
  isStrongPassword,
  isValidISODate,
  stripHtml,
  sanitizeStrings,
};
