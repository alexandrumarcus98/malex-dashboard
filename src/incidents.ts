/**
 * Synchronize open/resolved incident state for a named source (e.g. "probe:media", "vps:vps").
 * Keeps incident history concise by only creating rows on state transitions.
 */
export async function syncIncidentState(
  db: D1Database,
  params: {
    source: string;
    isHealthy: boolean;
    severity: "warn" | "critical";
    title: string;
    detail: string | null;
    nowSec: number;
  },
): Promise<void> {
  const existing = await db
    .prepare("SELECT id, severity, title FROM incidents WHERE source = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 1")
    .bind(params.source)
    .first<{ id: number; severity: string; title: string }>();

  if (params.isHealthy) {
    if (existing) {
      await db
        .prepare("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?")
        .bind(params.nowSec, existing.id)
        .run();
    }
    return;
  }

  if (existing) {
    if (existing.severity !== params.severity || existing.title !== params.title) {
      await db
        .prepare("UPDATE incidents SET severity = ?, title = ?, detail = ? WHERE id = ?")
        .bind(params.severity, params.title, params.detail, existing.id)
        .run();
    }
    return;
  }

  await db
    .prepare(
      "INSERT INTO incidents (source, severity, status, title, detail, opened_at) VALUES (?, ?, 'open', ?, ?, ?)",
    )
    .bind(params.source, params.severity, params.title, params.detail, params.nowSec)
    .run();
}

