-- Per-staff meeting duration overrides
-- Allows individual staff members to have custom meeting durations
CREATE TABLE IF NOT EXISTS staff_duration_overrides (
  id SERIAL PRIMARY KEY,
  staff_member_id INTEGER NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  meeting_type_id INTEGER NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  duration_minutes INTEGER NOT NULL,
  UNIQUE(staff_member_id, meeting_type_id)
);
