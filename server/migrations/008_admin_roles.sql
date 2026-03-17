-- Add role column to admin_users (default: restricted)
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'restricted';

-- Set existing admins
UPDATE admin_users SET role = 'admin' WHERE email IN ('admin@umai.io', 'margarida.c@letsumai.com');
