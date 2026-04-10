-- Add buffer and minimum advance time to meeting types
ALTER TABLE meeting_types ADD COLUMN IF NOT EXISTS buffer_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meeting_types ADD COLUMN IF NOT EXISTS min_advance_minutes INTEGER NOT NULL DEFAULT 60;
