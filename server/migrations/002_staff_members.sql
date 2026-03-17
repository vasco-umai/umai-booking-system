-- Staff members: team members who receive meeting bookings
CREATE TABLE IF NOT EXISTS staff_members (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  meeting_pct INTEGER NOT NULL DEFAULT 100 CHECK (meeting_pct BETWEEN 0 AND 100),
  google_calendar_id VARCHAR(255),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add staff_member_id to bookings (nullable FK, ON DELETE SET NULL)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS staff_member_id INTEGER
  REFERENCES staff_members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_staff ON bookings(staff_member_id);
CREATE INDEX IF NOT EXISTS idx_staff_active ON staff_members(is_active);
