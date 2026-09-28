// apps/worker/src/tasks/quality_freshness.ts
//
// Freshness alerter. Periodically lists the sources whose newest observation
// is older than their cadence allows (staleSources in
// packages/db/src/repo/source_freshness.ts, the same list /api/v1/admin/jobs
// shows as `stale_sources`) and posts a digest to a Discord webhook (if
// configured) or just logs warnings (if not).
//
// Why a single periodic job rather than per-source watchdog timers:
//   - Idempotent. Each run computes current state from observations
//     table, so missed runs don't queue up.
//   - One Discord message per run rather than N flapping notifications.
//
// Triggered hourly via crontab (`quality:freshness-check`). To suppress
// noisy alerts for a known-broken source, set its row in
// `source_priorities` to active=false.

import { type StaleSource, staleSources } from '@dam/db/repo/source_freshness';
import type { Task } from 'graphile-worker';

function severity(s: StaleSource): 'critical' | 'warning' {
  if (s.ageHours === null) return 'critical';
  return s.ageHours > s.thresholdHours * 3 ? 'critical' : 'warning';
}

function formatAge(hours: number | null): string {
  if (hours == null) return 'never';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} d`;
}

/** Discord rejects an embed with more fields than this, and with it the whole post. */
const MAX_EMBED_FIELDS = 25;

export function buildDiscordPayload(stale: StaleSource[]): {
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
  const critical = stale.filter((s) => severity(s) === 'critical');
  const color = critical.length > 0 ? 0xdc2626 : 0xf59e0b; // red / amber
  const shown = stale.length > MAX_EMBED_FIELDS ? stale.slice(0, MAX_EMBED_FIELDS - 1) : stale;
  const rest = stale.slice(shown.length);
  return {
    username: 'dam.teraren.com',
    embeds: [
      {
        title: `${stale.length} データソースが期待鮮度を下回っています`,
        description: 'Critical = 閾値の 3 倍超 / Warning = 閾値超過',
        color,
        fields: [
          ...shown.map((s) => ({
            name: `${severity(s) === 'critical' ? '🚨' : '⚠️'} ${s.sourceId}`,
            value: `最新: ${s.newestObservedAt ? s.newestObservedAt.toISOString() : 'なし'}\n経過: ${formatAge(s.ageHours)} (閾値 ${s.thresholdHours.toFixed(1)} h, ${s.cadenceBasis})`,
            inline: false,
          })),
          ...(rest.length > 0
            ? [
                {
                  name: `…and ${rest.length} more`,
                  // A field value is capped at 1024 characters.
                  value: rest
                    .map((s) => s.sourceId)
                    .join(', ')
                    .slice(0, 1024),
                  inline: false,
                },
              ]
            : []),
        ],
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
  const stale = await staleSources();
  log(`quality:freshness — ${stale.length} stale sources`);
  if (stale.length === 0) return;

  for (const s of stale) {
    log(
      `  ${severity(s) === 'critical' ? 'CRIT' : 'WARN'} ${s.sourceId}: age=${formatAge(s.ageHours)} (threshold ${s.thresholdHours.toFixed(1)}h, ${s.cadenceBasis})`,
    );
  }

  const webhook = process.env.DISCORD_FRESHNESS_WEBHOOK ?? '';
  if (!webhook) {
    log('quality:freshness — DISCORD_FRESHNESS_WEBHOOK not set; logging only');
    return;
  }
  await postDiscord(webhook, buildDiscordPayload(stale), log);
};

export default task;
