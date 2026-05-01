// packages/adapters/kasenbosai/src/adapter.ts
import { HttpClient } from '@dam/core/http_client';
import type {
  FetchContext,
  FetchTarget,
  ParsedReading,
  RawBytes,
  SourceAdapter,
} from '@dam/core/source_adapter';
import { previousEtag } from '@dam/db/repo/raw_snapshots';
import { parseKasenbosaiReading } from './parser.ts';
import { buildTargets } from './targets.ts';

const client = new HttpClient({
  userAgent:
    process.env.KASENBOSAI_USER_AGENT ??
    `DamDataPlatform/0.1 (+https://example.com/bot; ${process.env.HTTP_CONTACT_EMAIL ?? 'ops@example.com'})`,
  minIntervalMs: Number(process.env.KASENBOSAI_MIN_INTERVAL_MS ?? '1500'),
  maxRetries: 3,
  timeoutMs: 30_000,
});

export const kasenbosaiAdapter: SourceAdapter = {
  id: 'kasenbosai',
  schedule: 'hourly',
  async fetchTargets(_ctx: FetchContext): Promise<FetchTarget[]> {
    return buildTargets();
  },
  async fetchRaw(target, _ctx): Promise<RawBytes | null> {
    const ifNoneMatch = (await previousEtag('kasenbosai', target.targetId)) ?? undefined;
    const r = await client.get(target.url, { ifNoneMatch });
    if (r.status === 304) return null;
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${target.url}`);
    const raw: RawBytes = {
      bytes: r.bodyBytes,
      contentType: r.headers.get('content-type') ?? 'application/xml',
      status: r.status,
    };
    if (r.etag !== undefined) raw.etag = r.etag;
    return raw;
  },
  async parse(raw, _target): Promise<ParsedReading[]> {
    const xml = new TextDecoder('utf-8').decode(raw.bytes);
    const readings = parseKasenbosaiReading(xml);
    return readings.map((r) => ({
      damExternalId: { source: 'kasenbosai', id: r.damId },
      observedAt: r.observedAt,
      storageVolumeM3: r.storageVolumeM3,
      storageRate: r.storageRate,
      inflowM3s: r.inflowM3s,
      outflowM3s: r.outflowM3s,
      waterLevelM: r.waterLevelM,
      rainfallMm: r.rainfallMm,
    }));
  },
};
