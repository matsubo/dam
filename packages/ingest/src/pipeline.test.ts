import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SourceAdapter } from '@dam/core/source_adapter';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { runIngestForAdapter } from './pipeline.ts';

let damId: bigint;

beforeAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'ING-TEST-1'`;
  damId = await upsertDamByExternalId('ndi', {
    slug: 'ing-test-1',
    name: 'Ingest Test',
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    externalIds: { ndi: 'ING-TEST-1', kasenbosai: 'KB-TEST-1' },
  });
});

afterAll(async () => {
  await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
  await sql`DELETE FROM raw_snapshots WHERE source_id = 'kasenbosai-mock'`;
  await sql`DELETE FROM dams WHERE id = ${damId}`;
});

const adapter: SourceAdapter = {
  id: 'kasenbosai-mock',
  schedule: 'hourly',
  async fetchTargets() {
    return [{ targetId: 'KB-TEST-1', url: 'mock://x' }];
  },
  async fetchRaw() {
    return {
      bytes: new TextEncoder().encode('<x/>'),
      contentType: 'application/xml',
      status: 200,
    };
  },
  async parse() {
    return [
      {
        damExternalId: { source: 'kasenbosai', id: 'KB-TEST-1' },
        observedAt: new Date('2026-04-30T10:00:00Z'),
        storageVolumeM3: 500_000,
        storageRate: 0.5,
      },
    ];
  },
};

describe('runIngestForAdapter', () => {
  test('persists raw snapshot and observation', async () => {
    const r = await runIngestForAdapter(adapter, { runAt: new Date('2026-04-30T10:30:00Z') });
    expect(r.observationsWritten).toBe(1);
    expect(r.rawSnapshots).toBe(1);
    const obs = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM observations WHERE dam_id = ${damId}
    `;
    expect(Number(obs[0]?.n ?? 0)).toBe(1);
  });
});
