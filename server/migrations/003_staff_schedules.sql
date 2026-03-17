-- Add optional staff_member_id to schedules so each staff member can have
-- their own availability. NULL = global schedule (legacy / fallback).
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS staff_member_id INTEGER
  REFERENCES staff_members(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_schedules_staff ON schedules(staff_member_id);
