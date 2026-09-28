// Parser tests for かながわの水がめ (kanagawa-dam.jp/api/summary.php).
//
// Runs against the real response saved in tests/fixtures/kanagawa_dam, fetched
// 2026-09-28 12:55 JST. Its lastUpdate is 2026-09-27 and every series carries a
// `dt` that steps back one hour per key (sagami_volume 09-27 03:00, doushi_out
// 09-26 04:00) — a counter, not a reading time. The /api/weekly.php hourly
// table fetched at the same moment pins index 29 to 09-27: sagami level 164.99
// is its 09-28 0:00 reading, and sagami_in 82.00 is 9/27's hourly mean.

import { describe, expect, test } from 'bun:test';
import { parseKanagawaLastUpdate, parseKanagawaResponse } from './ingest_kanagawa.ts';

const FIXTURE = new URL(
  '../../../../tests/fixtures/kanagawa_dam/summary_0928.json',
  import.meta.url,
).pathname;

const body = await Bun.file(FIXTURE).json();
const rows = parseKanagawaResponse(body);

const at = (key: string, iso: string) =>
  rows.find((r) => r.key === key && r.observedAt.toISOString() === iso);

describe('parseKanagawaLastUpdate', () => {
  test('stamps a lastUpdate day at its 24:00 JST', () => {
    expect(parseKanagawaLastUpdate('2026-09-27')?.toISOString()).toBe('2026-09-27T15:00:00.000Z');
  });

  test('rejects anything but a bare YYYY-MM-DD', () => {
    expect(parseKanagawaLastUpdate('2026-09-27 03:00')).toBeNull();
    expect(parseKanagawaLastUpdate('')).toBeNull();
  });
});

describe('parseKanagawaResponse — the real response', () => {
  test('emits the 30-day window for every dam, newest day = lastUpdate', () => {
    for (const key of ['sagami', 'shiroyama', 'miho', 'miyagase', 'doushi']) {
      const times = rows
        .filter((r) => r.key === key)
        .map((r) => r.observedAt.toISOString())
        .sort();
      expect(times).toHaveLength(30);
      expect(times[0]).toBe('2026-08-29T15:00:00.000Z');
      expect(times[29]).toBe('2026-09-27T15:00:00.000Z');
    }
  });

  test('ignores the per-series dt: the newest reading is 9/27 24:00, not dt', () => {
    // sagami_volume.dt says 2026-09-27 03:00 and doushi_volume.dt 09-26 07:00;
    // stamping by dt left 道志 two days stale in prod.
    expect(at('sagami', '2026-09-27T15:00:00.000Z')?.storageVolumeM3).toBe(34_615_000);
    expect(at('doushi', '2026-09-27T15:00:00.000Z')?.storageVolumeM3).toBe(79_000);
  });

  test('maps the newest day of each field onto one row', () => {
    expect(at('sagami', '2026-09-27T15:00:00.000Z')).toEqual({
      key: 'sagami',
      observedAt: new Date('2026-09-27T15:00:00.000Z'),
      storageVolumeM3: 34_615_000,
      storageRate: 0.8613,
      waterLevelM: 164.99,
      inflowM3s: 82,
      outflowM3s: 75.25,
    });
  });

  test('index 0 is the oldest day of the window', () => {
    // sagami_volume["0"] = 34509, miho_storage_level["0"] = 85.00.
    expect(at('sagami', '2026-08-29T15:00:00.000Z')?.storageVolumeM3).toBe(34_509_000);
    expect(at('miho', '2026-08-29T15:00:00.000Z')?.storageRate).toBe(0.85);
  });

  test('a response without a parsable lastUpdate yields nothing', () => {
    expect(parseKanagawaResponse({ ...body, lastUpdate: '' })).toEqual([]);
  });
});
