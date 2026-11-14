-- Core schema for malex-dashboard (Cloudflare D1)

CREATE TABLE IF NOT EXISTS probe_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  detail_json TEXT,
  error TEXT,
  checked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_probe_target_time
  ON probe_samples (target, checked_at DESC);

CREATE TABLE IF NOT EXISTS vps_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  disk_pct REAL,
  mem_avail_mb INTEGER,
  mem_total_mb INTEGER,
  swap_used_pct REAL,
  swap_used_mb INTEGER,
  restic_age_h REAL,
  muuvies_age_h REAL,
  seedbox_sync_age_h REAL,
  containers_json TEXT,
  jibe_running INTEGER,
  jibe_total INTEGER,
  ports_json TEXT,
  summary TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vps_node_time
  ON vps_snapshots (node_id, created_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_incidents_status_time
  ON incidents (status, opened_at DESC);

CREATE TABLE IF NOT EXISTS cache_kv (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

