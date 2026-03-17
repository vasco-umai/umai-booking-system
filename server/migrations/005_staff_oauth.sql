-- Store Google OAuth refresh token per staff member for calendar access.
-- google_calendar_id will be auto-populated from the OAuth flow (primary calendar).
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;
