// apps/worker/src/tasks/quality_freshness.ts
//
// Freshness alerter. Periodically inspects each active source and flags
// the ones whose newest observation is older than expected for the
// source's cadence. Posts a digest to a Discord webhook (if configured)
// or just logs warnings (if not).
//
// Why a single periodic job rather than per-source watchdog timers:
//   - Idempotent. Each run computes current state from observations
//     table, so missed runs don't queue up.
//   - One Discord message per run rather than N flapping notifications.
//
// Triggered hourly via crontab (`quality:freshness-check`). To suppress
// noisy alerts for a known-broken source, set its row in
// `source_priorities` to active=false.

import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

/**
 * Per-source expected freshness window in hours. If the source's latest
 * observation is older than this, we flag it. Defaults to 30 h (covers
 * any source whose nominal cadence is daily).
 */
const FRESHNESS_HOURS: Record<string, number> = {
  // Hourly real-time sources — flag if older than 3 h.
  'kanagawa-dam': 3,
  'shiga-bousai': 3,
  'tottori-dam': 3,
  'aomori-dam': 3,
  'hkd-mlit-dam': 3,
  'cgr-mlit-dam': 3,
  'ktr-kinu-dam': 3,
  // Daily sources — flag if older than 30 h (allows late publish day).
  'tokyo-waterworks': 30,
  aitoyo: 30,
  'jwa-chikugo': 30,
  // 10-day cadence — flag if older than 14 days.
  'jwa-junpo': 14 * 24,
  // mudam is historical (1-2 yr lag) — don't alert.
};

interface SourceRow {
  source_id: string;
  description: string | null;
  latest_observed_at: Date | null;
  distinct_dams_30d: bigint;
}

interface AlertEntry {
  sourceId: string;
  latest: Date | null;
  expectedH: number;
  ageH: number | null;
}

function severity(a: AlertEntry): 'critical' | 'warning' {
  if (!a.latest || a.ageH == null) return 'critical';
  return a.ageH > a.expectedH * 3 ? 'critical' : 'warning';
}

function formatAge(hours: number | null): string {
  if (hours == null) return 'never';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

export function computeAlerts(rows: SourceRow[], now: Date = new Date()): AlertEntry[] {
  const out: AlertEntry[] = [];
  for (const r of rows) {
    const expectedH = FRESHNESS_HOURS[r.source_id];
    if (expectedH == null) continue; // unknown source — silent
    const latest = r.latest_observed_at;
    const ageH = latest ? (now.getTime() - latest.getTime()) / 3_600_000 : null;
    if (latest && ageH != null && ageH <= expectedH) continue;
    out.push({ sourceId: r.source_id, latest, expectedH, ageH });
  }
  return out;
}

function buildDiscordPayload(alerts: AlertEntry[]): {
  username: string;
  embeds: Array<{
    title: string;
    description: string;
    color: number;
    fields: Array<{ name: string; value: string; inline: boolean }>;
    footer: { text: string };
    timestamp: string;
  }>;
} {
  const critical = alerts.filter((a) => severity(a) === 'critical');
  const color = critical.length > 0 ? 0xdc2626 : 0xf59e0b; // red / amber
  return {
    username: 'dam.teraren.com',
    embeds: [
      {
        title: `${alerts.length} データソースが期待鮮度を下回っています`,
        description: 'Critical = 期待間隔の 3 倍超 / Warning = 期待間隔超過',
        color,
        fields: alerts.map((a) => ({
          name: `${severity(a) === 'critical' ? '🚨' : '⚠️'} ${a.sourceId}`,
          value: `最新: ${a.latest ? a.latest.toISOString() : 'なし'}\n経過: ${formatAge(a.ageH)} (期待 < ${a.expectedH} h)`,
          inline: false,
        })),
        footer: { text: 'https://dam.teraren.com/sources' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function postDiscord(
  webhookUrl: string,
  payload: object,
  log: (s: string) => void,
): Promise<void> {
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8_000),
    });
    if (r.status >= 200 && r.status < 300) {
      log('quality:freshness — Discord webhook posted');
    } else {
      log(`quality:freshness — Discord webhook failed: HTTP ${r.status}`);
    }
  } catch (err) {
    log(`quality:freshness — Discord webhook error: ${(err as Error).message}`);
  }
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  const rows = await sql<SourceRow[]>`
    SELECT
      sp.source_id,
      sp.description,
      o.latest AS latest_observed_at,
      COALESCE(o.distinct_dams_30d, 0)::BIGINT AS distinct_dams_30d
    FROM source_priorities sp
    LEFT JOIN LATERAL (
      SELECT
        MAX(observed_at) AS latest,
        COUNT(DISTINCT dam_id) FILTER (WHERE observed_at > NOW() - INTERVAL '30 days')::BIGINT AS distinct_dams_30d
      FROM observations
      WHERE source_id = sp.source_id
    ) o ON TRUE
    WHERE sp.active = true
  `;
  const alerts = computeAlerts(rows);
  log(`quality:freshness — checked ${rows.length} sources, ${alerts.length} stale`);
  if (alerts.length === 0) return;

  for (const a of alerts) {
    log(
      `  ${severity(a) === 'critical' ? 'CRIT' : 'WARN'} ${a.sourceId}: age=${formatAge(a.ageH)} (expect <${a.expectedH}h)`,
    );
  }

  const webhook = process.env.DISCORD_FRESHNESS_WEBHOOK ?? '';
  if (!webhook) {
    log('quality:freshness — DISCORD_FRESHNESS_WEBHOOK not set; logging only');
    return;
  }
  await postDiscord(webhook, buildDiscordPayload(alerts), log);
};

export default task;
