-- Add language column to bookings for multi-language email communication
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS lang VARCHAR(5) DEFAULT 'en';
