-- Add plan column to bookings to track which plan was selected at booking time
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS plan VARCHAR(20);
