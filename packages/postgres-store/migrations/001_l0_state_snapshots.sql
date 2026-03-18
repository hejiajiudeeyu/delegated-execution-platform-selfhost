CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS service_state_snapshots (
  service_name TEXT,
  state_json JSONB,
  updated_at TEXT
);
