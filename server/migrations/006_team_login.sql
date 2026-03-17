-- Allow team members to log in without a password on first access
-- and set their own password.

-- Make password_hash nullable (new team members start without one)
ALTER TABLE admin_users ALTER COLUMN password_hash DROP NOT NULL;

-- Track whether the user still needs to set a password
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS must_set_password BOOLEAN NOT NULL DEFAULT false;

-- Add a one-time password-reset token (used for forgot-password flow)
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255);
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
