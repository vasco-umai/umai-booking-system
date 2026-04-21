-- Public API keys for server-to-server consumers (AI voice agents, partner integrations).
-- Team-scoped: a key only grants access to its team's meeting types / bookings.
CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  key_hash VARCHAR(64) NOT NULL UNIQUE,        -- sha256 hex of the full key
  key_prefix VARCHAR(16) NOT NULL,             -- first ~12 chars, for display only (never the full key)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_team_active
  ON api_keys(team_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
  ON api_keys(key_hash)
  WHERE revoked_at IS NULL;
