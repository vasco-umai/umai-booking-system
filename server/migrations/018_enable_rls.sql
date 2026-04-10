-- Enable Row Level Security on all public tables.
--
-- The database is hosted on Supabase, which exposes a PostgREST API.
-- Without RLS, anyone with the public anon key can read/write all tables
-- directly, bypassing Express middleware auth entirely.
--
-- RLS enabled + no policies = deny-all for anon/authenticated roles.
-- The postgres role (used by DATABASE_URL) is a superuser and bypasses RLS.

ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_times ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_meeting_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_type_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_duration_overrides ENABLE ROW LEVEL SECURITY;
