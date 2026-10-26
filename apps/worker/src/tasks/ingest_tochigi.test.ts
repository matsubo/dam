// apps/worker/src/tasks/ingest_tochigi.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts). 栃木県 BODIK open-data CSV
// (NGSI-v2 shape, CC-BY 4.0, fetched from data.bodik.jp). Fixture is a
// verbatim 2026-05-27 capture.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reading } from '../ingest/types.ts';
import { splitCsvLine, tochigiEntries } from './ingest_tochigi.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/tochigi/tochigi_dampref_2026-05-27.csv',
);

const entries = async () => tochigiEntries(await readFile(FIXTURE, 'utf8'));

function observation(r: unknown) {
  const reading = r as Reading | undefined;
  if (reading?.state !== 'values') throw new Error('no values');
  const o = reading.observations[0];
  if (!o) throw new Error('no observation');
  return o;
}

describe('splitCsvLine', () => {
  test('keeps commas inside double-quoted fields', () => {
    const parts = splitCsvLine('"a","b,c","d"');
    expect(parts).toEqual(['a', 'b,c', 'd']);
  });

  test('handles RFC-4180 escaped double-quotes ("") inside a field', () => {
    // The Tochigi feed embeds a JSON value with "" escapes for the location.
    const parts = splitCsvLine('"x","{""type"":""Point""}","y"');
    expect(parts[1]).toBe('{"type":"Point"}');
  });

  test('passes unquoted fields through', () => {
    expect(splitCsvLine('1,2,3')).toEqual(['1', '2', '3']);
  });
});

describe('tochigiEntries', () => {
  test('one entry per dam, keyed by pointName, every one with values', async () => {
    const list = await entries();
    expect(list.length).toBe(7);
    for (const e of list) {
      expect(e.key).toMatch(/ダム$/);
      expect(e.name).toBe(e.key);
      expect(e.pref).toBe('09');
      expect(observation(e.reading).observedAt).toBeInstanceOf(Date);
    }
  });

  test('extracts 寺山ダム values (waterStorage 千m³ → m³)', async () => {
    const terayama = observation((await entries()).find((e) => e.key === '寺山ダム')?.reading);
    expect(terayama.waterLevelM).toBeCloseTo(394.46, 2);
    // 981.4 千m³ → 981,400 m³.
    expect(terayama.storageVolumeM3).toBe(981_400);
    expect(terayama.inflowM3s).toBeCloseTo(0.11, 3);
    expect(terayama.outflowM3s).toBeCloseTo(0.44, 3);
    // dateObserved is already UTC ISO — pass through.
    expect(terayama.observedAt.toISOString()).toBe('2026-05-27T15:50:00.000Z');
  });

  test('parses storage=0 (中禅寺ダム headworks shows zero stored volume)', async () => {
    const chuzenji = observation((await entries()).find((e) => e.key === '中禅寺ダム')?.reading);
    expect(chuzenji.storageVolumeM3).toBe(0);
  });

  test('a row without a parseable dateObserved is unreadable, not dropped', () => {
    const [e] = tochigiEntries('x,t,a,,1,loc,o,1,2,寺山ダム,1,r,s,394.46,981.4\n');
    expect(e?.key).toBe('寺山ダム');
    expect((e?.reading as Reading | undefined)?.state).toBe('unreadable');
  });

  test('returns empty array for header-only / empty input', () => {
    expect(tochigiEntries('"id","type","pointName"\n')).toEqual([]);
    expect(tochigiEntries('')).toEqual([]);
  });
});
