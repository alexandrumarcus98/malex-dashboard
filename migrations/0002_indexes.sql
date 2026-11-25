-- Add missing time-based indexes to eliminate full table scans on retention prunes and overview/history queries.

CREATE INDEX IF NOT EXISTS idx_probe_checked_at
  ON probe_samples (checked_at DESC, target, ok, latency_ms);

CREATE INDEX IF NOT EXISTS idx_vps_created_at
  ON vps_snapshots (created_at);

CREATE INDEX IF NOT EXISTS idx_vps_node_time_id
  ON vps_snapshots (node_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_incidents_status_resolved
  ON incidents (status, resolved_at);

