// apps/worker/src/tasks/ingest_shiga.test.ts
//
// Fixtures are verbatim Shift_JIS captures of 滋賀県土木防災情報システム's
// /mobile/ pages (robots.txt: Disallow /dam/, allow /mobile/), 2026-09-27
// 21:40 JST:
//   mobile_dam_select_*            /mobile/dam/dam_select.php (観測局一覧)
//   mobile_dam_data_34196_*        /mobile/dam/dam_data.php?ID=34196 (野洲川ダム)
//   mobile_dam_data_37191_*        /mobile/dam/dam_data.php?ID=37191 (姉川ダム,
//                                  every value "*" 欠測 / "-" 未観測 that day)

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseShigaDamData, parseShigaStationList } from './ingest_shiga.ts';

const FIXTURE_DIR = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/shiga_bousai');

async function fixture(file: string): Promise<string> {
  return new TextDecoder('shift_jis').decode(await readFile(join(FIXTURE_DIR, file)));
}

// 21:45 JST, a few minutes after the capture.
const REFERENCE = new Date('2026-09-27T12:45:00Z');

describe('parseShigaStationList', () => {
  test('lists every station the 観測局一覧 publishes with its ID', async () => {
    const stations = parseShigaStationList(
      await fixture('mobile_dam_select_2026-09-27.shiftjis.html'),
    );
    expect(stations).toEqual([
      { id: '34191', name: '青土ダム' },
      { id: '35152', name: '日野川ダム' },
      { id: '35691', name: '永源寺ダム' },
      { id: '34196', name: '野洲川ダム' },
      { id: '35696', name: '蔵王ダム' },
      { id: '39999', name: '犬上川ダム' },
      { id: '36191', name: '宇曽川ダム' },
      { id: '37191', name: '姉川ダム' },
      { id: '38191', name: '余呉湖' },
      { id: '39191', name: '石田川ダム' },
      { id: '39196', name: '天川ダム' },
    ]);
  });
});

describe('parseShigaDamData', () => {
  test('reads the latest 10-minute row and the hourly rows with JST times', async () => {
    const rows = parseShigaDamData(
      await fixture('mobile_dam_data_34196_2026-09-27.shiftjis.html'),
      REFERENCE,
    );
    expect(rows.map((r) => r.observedAt.toISOString())).toEqual([
      '2026-09-27T12:40:00.000Z',
      '2026-09-27T12:00:00.000Z',
      '2026-09-27T11:00:00.000Z',
      '2026-09-27T10:00:00.000Z',
      '2026-09-27T09:00:00.000Z',
      '2026-09-27T08:00:00.000Z',
      '2026-09-27T07:00:00.000Z',
    ]);
    expect(rows[0]).toEqual({
      observedAt: new Date('2026-09-27T12:40:00Z'),
      waterLevelM: 369.23,
      inflowM3s: 1.67,
      outflowM3s: 2.19,
      rainfallMm: 0,
    });
    expect(rows[6]?.rainfallMm).toBe(6);
  });

  test('drops rows whose level and flows are all 欠測 rather than writing empty rows', async () => {
    const rows = parseShigaDamData(
      await fixture('mobile_dam_data_37191_2026-09-27.shiftjis.html'),
      REFERENCE,
    );
    expect(rows).toEqual([]);
  });

  test('keeps a single 欠測 field as null', async () => {
    const html = (await fixture('mobile_dam_data_34196_2026-09-27.shiftjis.html')).replace(
      '［貯水位］369.23',
      '［貯水位］*',
    );
    const [latest] = parseShigaDamData(html, REFERENCE);
    expect(latest?.waterLevelM).toBeNull();
    expect(latest?.inflowM3s).toBe(1.67);
  });

  test('dates a 12/31 row seen just after New Year in the previous year', async () => {
    const html = (await fixture('mobile_dam_data_34196_2026-09-27.shiftjis.html')).replace(
      '<p>09/27 21:40',
      '<p>12/31 23:50',
    );
    const [latest] = parseShigaDamData(html, new Date('2026-12-31T15:05:00Z'));
    expect(latest?.observedAt.toISOString()).toBe('2026-12-31T14:50:00.000Z');
  });
});
