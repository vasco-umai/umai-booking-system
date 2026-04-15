-- Teams table
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-meeting-type assignment weights (replaces global meeting_pct)
CREATE TABLE IF NOT EXISTS staff_meeting_weights (
  id SERIAL PRIMARY KEY,
  staff_member_id INTEGER NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  meeting_type_id INTEGER NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  weight INTEGER NOT NULL DEFAULT 100 CHECK (weight >= 0 AND weight <= 100),
  UNIQUE(staff_member_id, meeting_type_id)
);

-- Add team_id to all scoped tables
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id);
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id);
ALTER TABLE blocked_times ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id);
ALTER TABLE meeting_types ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id);
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS team_id INTEGER REFERENCES teams(id);
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS team_role VARCHAR(20) DEFAULT 'member';

-- Seed default team + backfill existing data
INSERT INTO teams (name, slug) VALUES ('Customer Success', 'customer-success')
  ON CONFLICT (slug) DO NOTHING;

UPDATE staff_members SET team_id = (SELECT id FROM teams WHERE slug = 'customer-success') WHERE team_id IS NULL;
UPDATE bookings SET team_id = (SELECT id FROM teams WHERE slug = 'customer-success') WHERE team_id IS NULL;
UPDATE schedules SET team_id = (SELECT id FROM teams WHERE slug = 'customer-success') WHERE team_id IS NULL;
UPDATE blocked_times SET team_id = (SELECT id FROM teams WHERE slug = 'customer-success') WHERE team_id IS NULL;
UPDATE meeting_types SET team_id = (SELECT id FROM teams WHERE slug = 'customer-success') WHERE team_id IS NULL;
UPDATE admin_users SET team_id = (SELECT id FROM teams WHERE slug = 'customer-success') WHERE team_id IS NULL;

-- Make team_id NOT NULL after backfill
ALTER TABLE staff_members ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE bookings ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE schedules ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE blocked_times ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE meeting_types ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE admin_users ALTER COLUMN team_id SET NOT NULL;

-- Indexes for team scoping
CREATE INDEX IF NOT EXISTS idx_staff_team ON staff_members(team_id);
CREATE INDEX IF NOT EXISTS idx_bookings_team ON bookings(team_id);
CREATE INDEX IF NOT EXISTS idx_schedules_team ON schedules(team_id);
CREATE INDEX IF NOT EXISTS idx_blocked_team ON blocked_times(team_id);
CREATE INDEX IF NOT EXISTS idx_meeting_types_team ON meeting_types(team_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_team ON admin_users(team_id);
