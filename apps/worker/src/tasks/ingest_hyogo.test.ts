// apps/worker/src/tasks/ingest_hyogo.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts). The CSV (CC-BY 4.0, 10-min
// refresh) is exposed at a stable URL on data.bodik.jp. Fixture is a verbatim
// capture from 2026-05-26.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reading } from '../ingest/types.ts';
import { hyogoEntries } from './ingest_hyogo.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/hyogo/tm-dam_2026-05-26.csv',
);

const entries = async () => hyogoEntries(await readFile(FIXTURE, 'utf8'));

function observation(r: unknown) {
  const reading = r as Reading | undefined;
  if (reading?.state !== 'values') throw new Error('no values');
  const o = reading.observations[0];
  if (!o) throw new Error('no observation');
  return o;
}

describe('hyogoEntries', () => {
  test('one entry per station, keyed by 観測所名', async () => {
    const list = await entries();
    // 22 data rows in the fixture (incl. 分水堰 weir).
    expect(list.length).toBe(22);
    expect(list.every((e) => e.key === e.name && e.pref === '28')).toBe(true);
  });

  test('the 分水堰 weir is recorded but never bound', async () => {
    const weir = (await entries()).find((e) => e.name === '分水堰');
    expect(weir?.bind).toBe('never');
  });

  test('extracts 青野ダム values (貯水量 千m³ → m³)', async () => {
    const aono = observation((await entries()).find((e) => e.name === '青野ダム')?.reading);
    expect(aono.waterLevelM).toBeCloseTo(180.81, 2);
    // 8706 千m³ → 8,706,000 m³.
    expect(aono.storageVolumeM3).toBe(8_706_000);
    expect(aono.inflowM3s).toBeCloseTo(0.27, 3);
    expect(aono.outflowM3s).toBeCloseTo(0.95, 3);
    // 2026/05/26 13:10 JST = 04:10 UTC.
    expect(aono.observedAt.toISOString()).toBe('2026-05-26T04:10:00.000Z');
  });

  test('nulls a value whose flag is non-zero (但東ダム 貯水量 flag=160)', async () => {
    const tanto = observation((await entries()).find((e) => e.name === '但東ダム')?.reading);
    expect(tanto.storageVolumeM3).toBeNull();
    // its other (flag=0) fields still come through.
    expect(tanto.inflowM3s).toBeCloseTo(0.026, 3);
  });

  test('a station flagged on every field is provider-marked empty', () => {
    const [e] = hyogoEntries('1,青野ダム,2026/05/26 13:10,,160,,160,,160,,160\n');
    expect((e?.reading as Reading | undefined)?.state).toBe('empty');
  });

  test('an unparseable 観測時刻 is unreadable, not dropped', () => {
    const [e] = hyogoEntries('1,青野ダム,欠測,180.81,0,8706,0,0.270,0,0.950,0\n');
    expect((e?.reading as Reading | undefined)?.state).toBe('unreadable');
  });

  test('returns empty array for header-only / empty input', () => {
    expect(hyogoEntries('局番号,観測所名,観測時刻\n')).toEqual([]);
    expect(hyogoEntries('')).toEqual([]);
  });
});
