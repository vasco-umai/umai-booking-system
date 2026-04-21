const crypto = require('crypto');

/**
 * SHA-256 hex digest of a token. Used to store invite/reset tokens hashed
 * in admin_users.invite_token_hash / reset_token_hash instead of plaintext.
 *
 * Not intended as a password hash — these tokens have 256 bits of entropy
 * (`crypto.randomBytes(32)`), so a fast hash is appropriate. bcrypt/argon2
 * would be needlessly slow here.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Constant-time comparison of two hex hashes, guarding against timing attacks
 * on the DB lookup + compare path. Both args must be same length for
 * timingSafeEqual; we pad to 64 chars to normalize.
 */
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { hashToken, timingSafeEqualHex };
