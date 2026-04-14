-- Max meetings per day per staff member for this meeting type (0 = unlimited)
ALTER TABLE meeting_types ADD COLUMN IF NOT EXISTS max_daily_meetings INTEGER DEFAULT 0;
