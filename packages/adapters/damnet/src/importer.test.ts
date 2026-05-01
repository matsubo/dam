import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { importDamnetDetail } from './importer.ts';

beforeAll(async () => {
  await upsertDamByExternalId('ndi', {
    slug: 'yanba-10',
    name: '八ッ場ダム',
    prefCode: '10',
    manager: '国土交通省関東地方整備局',
    lat: 36.55,
    lng: 138.69,
    externalIds: { ndi: 'TEST-DAMNET-1' },
  });
});

afterAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'TEST-DAMNET-1'`;
  await sql`DELETE FROM match_review WHERE source_id = 'damnet'`;
});

describe('importDamnetDetail', () => {
  test('attaches damnet id and applies attributes when match high', async () => {
    const r = await importDamnetDetail({
      damnetId: '1234',
      name: '八ッ場ダム',
      nameKana: 'やんばだむ',
      prefCode: '10',
      manager: '国土交通省関東地方整備局',
      type: '重力式コンクリート',
      heightM: 116,
      totalCapacityM3: 107500000,
      effectiveCapacityM3: 90000000,
      floodCapacityM3: 65000000,
      completedYear: 2020,
      lat: 36.5501,
      lng: 138.6901,
    });
    expect(r.outcome).toBe('matched');
    const rows = await sql<{ external_ids: Record<string, string>; type: string | null }[]>`
      SELECT external_ids, type FROM dams WHERE external_ids ->> 'ndi' = 'TEST-DAMNET-1'
    `;
    expect(rows[0]?.external_ids.damnet).toBe('1234');
    expect(rows[0]?.type).toBe('重力式コンクリート');
  });

  test('enqueues match_review when no high-confidence candidate', async () => {
    const r = await importDamnetDetail({
      damnetId: '7777',
      name: 'ダミーダム',
      prefCode: '10',
      lat: 36.0,
      lng: 138.0,
    });
    expect(r.outcome).toBe('review_enqueued');
    const rows = await sql<{ source_external_id: string }[]>`
      SELECT source_external_id FROM match_review WHERE source_id = 'damnet'
    `;
    expect(rows.map((x) => x.source_external_id)).toContain('7777');
  });
});
