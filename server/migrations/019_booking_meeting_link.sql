-- Add meeting_link column to store Google Meet link for online bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS meeting_link VARCHAR(500);
