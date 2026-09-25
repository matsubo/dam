import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { applyDamnetCaptures, type DamInfo } from './apply_captures.ts';

// Fixture rows are keyed by these NDI ids; cleanup is scoped to them only.
const NDI_OLD = '9999999997';
const NDI_NEW = '9999999998';

const capture = (dam_number: string, dam_name: string, capacity_active: string): DamInfo => ({
  id: 0,
  dam_number,
  dam_name,
  dam_name_kana: '',
  prefecture: '北海道',
  river_name: '',
  completion_year: '',
  construction_start_year: '',
  type: '',
  height: '',
  capacity_total: '',
  capacity_active,
  operator: '',
  purposes: '',
  crest_length: '',
  embankment_volume: '',
  watershed_area: '',
  reservoir_area: '',
  left_bank_location: '',
  main_contractor: '',
  redevelopment_status: '',
});

async function cleanup(): Promise<void> {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' IN (${NDI_OLD}, ${NDI_NEW})`;
}

beforeAll(async () => {
  await cleanup();
  // A （元）/（再） pair holding each other's ダム便覧 numbers, as #54 found.
  for (const [ndi, slug, name, damnet] of [
    [NDI_OLD, 'fixture-54-moto', '試験五十四（元）', 'T902'],
    [NDI_NEW, 'fixture-54-sai', '試験五十四（再）', 'T901'],
  ] as const) {
    await sql`
      INSERT INTO dams (slug, name, pref_code, location, external_ids)
      VALUES (${slug}, ${name}, '01', ST_GeogFromText('POINT(142 43)'),
              jsonb_build_object('ndi', ${ndi}::text, 'damnet', ${damnet}::text))
    `;
  }
});

afterAll(cleanup);

describe('applyDamnetCaptures', () => {
  const captures = [
    capture('T901', '試験五十四ダム（元）', '100'),
    capture('T902', '試験五十四ダム（再）', '200'),
  ];

  test('swaps crossed stamps and gives each row its own record', async () => {
    const stats = await applyDamnetCaptures(captures, () => {});
    expect(stats.restamped).toBe(2);
    const rows = await sql<{ ndi: string; damnet: string; cap: string }[]>`
      SELECT external_ids->>'ndi' AS ndi, external_ids->>'damnet' AS damnet,
             active_capacity_m3::text AS cap
      FROM dams WHERE external_ids ->> 'ndi' IN (${NDI_OLD}, ${NDI_NEW}) ORDER BY 1
    `;
    expect([...rows]).toEqual([
      { ndi: NDI_OLD, damnet: 'T901', cap: '100000.00' },
      { ndi: NDI_NEW, damnet: 'T902', cap: '200000.00' },
    ]);
  });

  test('a rerun changes no stamps', async () => {
    const stats = await applyDamnetCaptures(captures, () => {});
    expect(stats.restamped).toBe(0);
  });
});
