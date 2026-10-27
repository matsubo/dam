// Fixture → universe entries for かながわの水がめ (kanagawa-dam.jp/api/summary.php),
// no database: binding and writing belong to the ingest run
// (apps/worker/src/ingest/run.test.ts).
//
// Runs against the real response saved in tests/fixtures/kanagawa_dam, fetched
// 2026-09-28 12:55 JST. Its lastUpdate is 2026-09-27 and every series carries a
// `dt` that steps back one hour per key (sagami_volume 09-27 03:00, doushi_out
// 09-26 04:00) — a counter, not a reading time. The /api/weekly.php hourly
// table fetched at the same moment pins index 29 to 09-27: sagami level 164.99
// is its 09-28 0:00 reading, and sagami_in 82.00 is 9/27's hourly mean.

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import {
  type ApiResponse,
  kanagawaEntries,
  kanagawaUnreadable,
  parseKanagawaLastUpdate,
} from './ingest_kanagawa.ts';

const FIXTURE = new URL(
  '../../../../tests/fixtures/kanagawa_dam/summary_0928.json',
  import.meta.url,
).pathname;

const body = (await Bun.file(FIXTURE).json()) as ApiResponse;
const entries = kanagawaEntries(body);

function observations(e: Entry | undefined): readonly Observed[] {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations;
}

const at = (key: string, iso: string) =>
  observations(entries.find((e) => e.key === key)).find((o) => o.observedAt.toISOString() === iso);

describe('parseKanagawaLastUpdate', () => {
  test('stamps a lastUpdate day at its 24:00 JST', () => {
    expect(parseKanagawaLastUpdate('2026-09-27')?.toISOString()).toBe('2026-09-27T15:00:00.000Z');
  });

  test('rejects anything but a bare YYYY-MM-DD', () => {
    expect(parseKanagawaLastUpdate('2026-09-27 03:00')).toBeNull();
    expect(parseKanagawaLastUpdate('')).toBeNull();
  });
});

describe('kanagawaEntries — the real response', () => {
  test('lists the five dams by API key under their master names', () => {
    expect(entries.map((e) => [e.key, e.name, e.pref])).toEqual([
      ['sagami', '相模', '14'],
      ['shiroyama', '城山', '14'],
      ['miho', '三保', '14'],
      ['miyagase', '宮ヶ瀬', '14'],
      ['doushi', '道志', '14'],
    ]);
  });

  test('reads the 30-day window for every dam, newest day = lastUpdate', () => {
    for (const e of entries) {
      const times = observations(e)
        .map((o) => o.observedAt.toISOString())
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

  test('maps the newest day of each field onto one observation', () => {
    expect(at('sagami', '2026-09-27T15:00:00.000Z')).toEqual({
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

  test('a response without a parsable lastUpdate lists every dam unreadable', () => {
    const list = kanagawaEntries({ ...body, lastUpdate: '' });
    expect(list).toHaveLength(5);
    for (const e of list) expect(e.reading).toEqual({ state: 'unreadable', why: 'lastUpdate ""' });
  });

  test('a dam whose series are gone is unreadable, the others still read', () => {
    const values = Object.fromEntries(
      Object.entries(body.values).filter(([k]) => !k.startsWith('doushi_')),
    );
    const list = kanagawaEntries({ ...body, values });
    const states = list.map((e) => (typeof e.reading === 'function' ? '' : e.reading.state));
    expect(states).toEqual(['values', 'values', 'values', 'values', 'unreadable']);
  });
});

describe('kanagawaUnreadable', () => {
  test('keeps the catalogue listed when the API cannot be read', () => {
    const list = kanagawaUnreadable('summary.php: HTTP 503');
    expect(list.map((e) => e.key)).toEqual(['sagami', 'shiroyama', 'miho', 'miyagase', 'doushi']);
    expect(list[0]?.reading).toEqual({ state: 'unreadable', why: 'summary.php: HTTP 503' });
  });
});
