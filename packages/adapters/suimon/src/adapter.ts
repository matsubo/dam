// packages/adapters/suimon/src/adapter.ts
import { HttpClient } from '@dam/core/http_client';
import type {
  FetchContext,
  FetchTarget,
  ParsedReading,
  RawBytes,
  SourceAdapter,
} from '@dam/core/source_adapter';
import { sql } from '@dam/db/client';
import { nextPending } from '@dam/db/repo/backfill_progress';
import { parseSuimonCsv } from './parser.ts';

const client = new HttpClient({
  userAgent:
    process.env.SUIMON_USER_AGENT ??
    `DamDataPlatform/0.1 (+https://example.com/bot; ${process.env.HTTP_CONTACT_EMAIL ?? 'ops@example.com'})`,
  minIntervalMs: Number(process.env.SUIMON_MIN_INTERVAL_MS ?? '5000'),
  maxRetries: 3,
  timeoutMs: 60_000,
});

interface SuimonTarget extends FetchTarget {
  meta: { suimonId: string; year: string; damId: string };
}

const BASE =
  process.env.SUIMON_BASE_URL ?? 'https://www1.river.go.jp/sample/?type=DamReservoir&id=';

async function suimonIdsByDamIds(damIds: bigint[]): Promise<Map<bigint, string>> {
  if (damIds.length === 0) return new Map();
  const rows = await sql<{ id: bigint; suimon: string | null }[]>`
    SELECT id, external_ids ->> 'suimon' AS suimon FROM dams WHERE id = ANY(${damIds}::bigint[])
  `;
  const out = new Map<bigint, string>();
  for (const r of rows) {
    if (r.suimon) out.set(r.id, r.suimon);
  }
  return out;
}

export const suimonAdapter: SourceAdapter = {
  id: 'suimon',
  schedule: 'on-demand',
  async fetchTargets(_ctx: FetchContext): Promise<FetchTarget[]> {
    const pending = await nextPending('suimon', Number(process.env.SUIMON_BATCH ?? '5'));
    const ids = await suimonIdsByDamIds(pending.map((p) => p.damId));
    const targets: SuimonTarget[] = [];
    for (const p of pending) {
      const suimonId = ids.get(p.damId);
      if (!suimonId) continue;
      targets.push({
        targetId: `${suimonId}-${p.year}`,
        url: `${BASE}${encodeURIComponent(suimonId)}&year=${p.year}`,
        meta: { suimonId, year: String(p.year), damId: String(p.damId) },
      });
    }
    return targets;
  },
  async fetchRaw(target, _ctx): Promise<RawBytes | null> {
    const r = await client.get(target.url);
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${target.url}`);
    const raw: RawBytes = {
      bytes: r.bodyBytes,
      contentType: r.headers.get('content-type') ?? 'text/csv',
      status: r.status,
    };
    if (r.etag !== undefined) raw.etag = r.etag;
    return raw;
  },
  async parse(raw, target): Promise<ParsedReading[]> {
    const csv = new TextDecoder('utf-8').decode(raw.bytes);
    const rows = parseSuimonCsv(csv);
    const meta = (target as SuimonTarget).meta;
    return rows.map((row) => ({
      damExternalId: { source: 'suimon', id: meta.suimonId },
      observedAt: row.observedAt,
      storageVolumeM3: row.storageVolumeM3,
      storageRate: row.storageRate,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: row.rainfallMm,
    }));
  },
};
