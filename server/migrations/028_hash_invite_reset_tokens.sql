-- H3: store invite and reset tokens as SHA-256 hashes instead of plaintext.
--
-- Rationale: if the admin_users table ever leaks (DB dump, future SQLi, backup
-- stolen), plaintext tokens were directly usable for account takeover of every
-- user with an outstanding invite or reset. Hashing closes that window.
--
-- Zero-downtime strategy: add nullable hash columns alongside the existing
-- plaintext columns. Code writes new tokens to _hash; reads fall back to the
-- legacy plaintext column when the hash column is null (for tokens issued
-- before this migration). All legacy tokens age out within 7 days (invite
-- expiry) or 1 hour (reset expiry), at which point a follow-up migration
-- drops the plaintext columns.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS invite_token_hash CHAR(64);
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reset_token_hash CHAR(64);

-- Partial indexes so hash lookups are cheap without bloating the index for
-- rows that don't have an outstanding token.
CREATE INDEX IF NOT EXISTS idx_admin_invite_hash
  ON admin_users(invite_token_hash)
  WHERE invite_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_reset_hash
  ON admin_users(reset_token_hash)
  WHERE reset_token_hash IS NOT NULL;
