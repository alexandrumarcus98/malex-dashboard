export const NODE_STALE_SEC = 35 * 60;
export const MANUAL_CRON_COOLDOWN_SEC = 60;

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CF_ZONE_ID: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  CF_INGEST_ACCESS_AUD?: string;
  INGEST_BEARER_TOKEN?: string;
  HEALTHCHECKS_API_KEY?: string;
  CF_ANALYTICS_TOKEN?: string;
  LOCAL_DEV_BYPASS?: string;
}

export interface ProbeTarget {
  id: string;
  label: string;
  url: string;
  parseJson?: boolean;
}

export interface ProbeResult {
  target: string;
  label: string;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  detailJson: string | null;
  error: string | null;
  checkedAt: number;
}

export interface ContainerState {
  name: string;
  status: string;
  healthy: boolean;
}

export interface PortState {
  port: number;
  label: string;
  open: boolean;
}

export interface VpsIngestPayload {
  node_id?: string;
  status: "OK" | "WARN" | "FAIL";
  disk_pct?: number | null;
  mem_avail_mb?: number | null;
  mem_total_mb?: number | null;
  swap_used_pct?: number | null;
  swap_used_mb?: number | null;
  restic_age_h?: number | null;
  muuvies_age_h?: number | null;
  seedbox_sync_age_h?: number | null;
  containers?: ContainerState[];
  jibe_running?: number | null;
  jibe_total?: number | null;
  ports?: PortState[];
  summary?: string | null;
}

export interface HealthcheckItem {
  name: string;
  slug: string;
  status: string;
  lastPing: string | null;
  nextPing: string | null;
  nPings: number;
  graceSec: number;
}

export interface CfDayPoint {
  date: string;
  requests: number;
  cachedRequests: number;
  bytes: number;
  threats: number;
  pageViews: number;
}

export interface IncidentRow {
  id: number;
  source: string;
  severity: string;
  status: string;
  title: string;
  detail: string | null;
  opened_at: number;
  resolved_at: number | null;
}

