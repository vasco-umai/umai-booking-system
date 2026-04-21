-- Idempotency keys for POST /api/public/bookings.
-- A retry with the same (team_id, key) within the retention window returns the
-- original response verbatim, so flaky networks / AI-agent retries never
-- create duplicate bookings.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  request_hash VARCHAR(64) NOT NULL,          -- sha256 of canonical request body, catches key reuse with different body
  response_body JSONB NOT NULL,
  response_status INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
