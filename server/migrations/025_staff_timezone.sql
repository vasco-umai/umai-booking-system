-- Staff member IANA timezone (for staff-facing notifications and future scheduling UX).
-- Default keeps existing rows + new staff working without a UI backfill.
-- Code in emailService.js:226 already reads staff.timezone; this migration makes that field real.
ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Lisbon';
