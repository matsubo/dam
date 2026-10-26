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
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseSayamaikeCsv,
  sayamaikeEntries,
  sayamaikeReading,
} from './ingest_shioda_sayamaike.ts';

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

describe('sayamaikeReading', () => {
  test('the fixture has values', async () => {
    const r = sayamaikeReading(await readFile(FIXTURE, 'utf8'), LAST_MODIFIED);
    expect(r.state).toBe('values');
  });

  test('hourly rain alone is not a reading of the reservoir', () => {
    expect(sayamaikeReading('586x,1082409,,,0.00,0.00,0.00,,0,14,19,4\r\n', LAST_MODIFIED)).toEqual(
      {
        state: 'unreadable',
        why: 'no level, volume, rate or inflow',
      },
    );
  });
});

describe('sayamaikeEntries', () => {
  test('the one reservoir, matched only by its exact name inside 長野', () => {
    const [e, ...rest] = sayamaikeEntries({ state: 'unreadable', why: 'x' });
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ key: '沢山池', name: '沢山池', pref: '20', bind: { exact: true } });
  });
});
