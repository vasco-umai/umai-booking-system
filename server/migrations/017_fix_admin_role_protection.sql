-- Ensure Margarida has admin role (fixes current broken state)
UPDATE admin_users SET role = 'admin' WHERE LOWER(email) = 'margarida.c@letsumai.com';

-- Normalize all emails to lowercase to prevent case-mismatch conflicts
UPDATE admin_users SET email = LOWER(email) WHERE email != LOWER(email);
UPDATE staff_members SET email = LOWER(email) WHERE email != LOWER(email);
