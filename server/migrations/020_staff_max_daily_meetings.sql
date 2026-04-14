-- Max meetings per day per staff member (0 or NULL = unlimited)
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS max_daily_meetings INTEGER DEFAULT 0;
