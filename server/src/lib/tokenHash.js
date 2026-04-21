const crypto = require('crypto');

/**
 * SHA-256 hex digest of a token. Used to store invite/reset tokens hashed
 * in admin_users.invite_token_hash / reset_token_hash instead of plaintext.
 *
 * Not intended as a password hash — these tokens have 256 bits of entropy
 * (`crypto.randomBytes(32)`), so a fast hash is appropriate. bcrypt/argon2
 * would be needlessly slow here.
 *
 * Note on timing attacks: we rely on Postgres's standard equality on the
 * `_hash` column for lookup. A constant-time JS comparison would be required
 * only if an attacker could observe per-byte DB response time over the
 * network. The real tokens are 256-bit random values — guessing one requires
 * ~2^256 work, so practical timing discrimination is not useful here. Keeping
 * the note so future callers don't reach for a helper that would add ceremony
 * without benefit.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { hashToken };
