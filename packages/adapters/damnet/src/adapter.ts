// packages/adapters/damnet/src/adapter.ts
//
// Formal SourceAdapter wrapper around the Damnet master scraper. Damnet is
// master metadata (no per-hour observations), so `parse()` returns an empty
// array. The wrapper exists so the worker pipeline can list every source
// uniformly. The actual list/detail scrape and import is invoked separately
// via the existing CLI / `master_refresh_*` worker tasks.
import { HttpClient } from '@dam/core/http_client';
import type {
  FetchContext,
  FetchTarget,
  ParsedReading,
  RawBytes,
  SourceAdapter,
} from '@dam/core/source_adapter';

const LIST_URL =
  process.env.DAMNET_LIST_URL ?? 'https://damnet.or.jp/Dambinran/binran/All_Dam.html';

const client = new HttpClient({
  userAgent:
    process.env.DAMNET_USER_AGENT ??
    `DamDataPlatform/0.1 (+https://example.com/bot; ${process.env.HTTP_CONTACT_EMAIL ?? 'ops@example.com'})`,
  minIntervalMs: Number(process.env.DAMNET_MIN_INTERVAL_MS ?? '2000'),
  maxRetries: 3,
  timeoutMs: 30_000,
});

export const damnetAdapter: SourceAdapter = {
  id: 'damnet',
  schedule: 'on-demand',
  async fetchTargets(_ctx: FetchContext): Promise<FetchTarget[]> {
    return [{ targetId: 'list', url: LIST_URL }];
  },
  async fetchRaw(target, _ctx): Promise<RawBytes | null> {
    const r = await client.get(target.url);
    if (r.status !== 200) throw new Error(`HTTP ${r.status} ${target.url}`);
    const raw: RawBytes = {
      bytes: r.bodyBytes,
      contentType: r.headers.get('content-type') ?? 'text/html',
      status: r.status,
    };
    if (r.etag !== undefined) raw.etag = r.etag;
    return raw;
  },
  async parse(_raw, _target): Promise<ParsedReading[]> {
    // Damnet rows are master data, not observations. Return empty so
    // the pipeline doesn't write to observations; the master importer
    // is invoked separately.
    return [];
  },
};
