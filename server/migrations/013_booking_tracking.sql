-- Track Google Calendar sync failures and email delivery status
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS gcal_sync_failed BOOLEAN DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirmation_email_sent BOOLEAN DEFAULT false;
