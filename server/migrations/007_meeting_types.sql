-- Meeting types configuration (online, in_person, etc.)
CREATE TABLE IF NOT EXISTS meeting_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  label VARCHAR(100) NOT NULL,
  duration_minutes INTEGER NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Which plans can use which meeting types
CREATE TABLE IF NOT EXISTS plan_meeting_types (
  id SERIAL PRIMARY KEY,
  plan_name VARCHAR(20) NOT NULL,
  meeting_type_id INTEGER NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  UNIQUE(plan_name, meeting_type_id)
);

-- Day-of-week availability per meeting type
CREATE TABLE IF NOT EXISTS meeting_type_schedules (
  id SERIAL PRIMARY KEY,
  meeting_type_id INTEGER NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_available BOOLEAN NOT NULL DEFAULT true,
  UNIQUE(meeting_type_id, day_of_week)
);

-- Add meeting_type_id to bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS meeting_type_id INTEGER REFERENCES meeting_types(id);
