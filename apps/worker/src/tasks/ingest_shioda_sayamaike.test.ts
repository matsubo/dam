// apps/worker/src/tasks/ingest_shioda_sayamaike.test.ts
//
// Fixture is a verbatim capture of 上田市塩田平土地改良区's 沢山池 feed
// (midorinet-shioda.or.jp/reservoir/sayamaike/data/SFTP.csv), taken
// 2026-09-28 16:02 JST; the response had Last-Modified 07:01:10 GMT. One CRLF
// line of 12 comma-separated fields, in the order the 状況図 page's script
// reads them: 現在貯水位 586.26, 総貯水量 1082409, 現在貯水量 86035,
// 現在貯水率 8, three release columns the page stopped showing on 2026-03-13
// (0.00 ×3), 全流入量 0.34, 時間雨量 0, 累計雨量 14, 外気温 19, and the index
// of the water-level picture (4).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import { matchSayamaike, parseSayamaikeCsv } from './ingest_shioda_sayamaike.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/shioda_sayamaike/SFTP_2026-09-28.csv',
);
const LAST_MODIFIED = 'Mon, 28 Sep 2026 07:01:10 GMT';

describe('parseSayamaikeCsv', () => {
  test('reads level, volume, rate, inflow and hourly rain at the upload’s 10-minute mark', async () => {
    const csv = await readFile(FIXTURE, 'utf8');
    expect(parseSayamaikeCsv(csv, LAST_MODIFIED)).toEqual({
      // The file is re-uploaded a minute past every 10-minute mark and carries
      // no time of its own.
      observedAt: new Date('2026-09-28T07:00:00Z'),
      waterLevelM: 586.26,
      storageVolumeM3: 86_035,
      storageRate: 0.08,
      inflowM3s: 0.34,
      rainfallMm: 0,
    });
  });

  test('an empty field is null, not zero', () => {
    const r = parseSayamaikeCsv('586.26,1082409,,,0.00,0.00,0.00,,0,14,19,4\r\n', LAST_MODIFIED);
    expect(r.storageVolumeM3).toBeNull();
    expect(r.storageRate).toBeNull();
    expect(r.inflowM3s).toBeNull();
    expect(r.waterLevelM).toBe(586.26);
  });

  test('a short line or a missing Last-Modified is a layout change, not data', () => {
    expect(() => parseSayamaikeCsv('586.26,1082409,86035\r\n', LAST_MODIFIED)).toThrow();
    expect(() =>
      parseSayamaikeCsv('586.26,1082409,86035,8,0.00,0.00,0.00,0.34,0,14,19,4\r\n', null),
    ).toThrow();
  });
});

describe('matchSayamaike', () => {
  // Synthetic rows: the 長野 沢山池 and a namesake elsewhere that must not bind.
  const SLUGS = ['shioda-sayamaike-t-nagano', 'shioda-sayamaike-t-other'];

  async function insertDam(slug: string, prefCode: string): Promise<bigint> {
    const rows = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, location, external_ids)
      VALUES (${slug}, '沢山池', ${prefCode},
              ST_SetSRID(ST_MakePoint(138.17, 36.33), 4326)::geography, '{}'::jsonb)
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('insert dam failed');
    return id;
  }

  beforeEach(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });

  test('binds and stamps the 長野 row only', async () => {
    const nagano = await insertDam(SLUGS[0] as string, '20');
    await insertDam(SLUGS[1] as string, '28');

    expect(await matchSayamaike(() => {})).toBe(nagano);
    const [row] = await sql<{ k: string | null }[]>`
      SELECT external_ids->>'shioda-sayamaike' AS k FROM dams WHERE id = ${nagano}
    `;
    expect(row?.k).toBe('沢山池');
  });
});
