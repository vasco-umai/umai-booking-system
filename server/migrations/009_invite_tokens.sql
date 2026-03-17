-- Add invite token columns for self-service staff onboarding
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS invite_token TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS invite_token_expires TIMESTAMPTZ;
