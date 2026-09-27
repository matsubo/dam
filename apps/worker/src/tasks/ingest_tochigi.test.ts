// apps/worker/src/tasks/ingest_tochigi.test.ts
//
// Pure-function tests for the 栃木県 BODIK open-data CSV parser (NGSI-v2
// shape, CC-BY 4.0, fetched from data.bodik.jp). Fixture is a verbatim
// 2026-05-27 capture.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseMaster, parseTochigiCsv, splitCsvLine } from './ingest_tochigi.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/tochigi/tochigi_dampref_2026-05-27.csv',
);

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

describe('parseTochigiCsv', () => {
  test('extracts one row per dam with values converted', async () => {
    const rows = parseTochigiCsv(await readFile(FIXTURE, 'utf8'));
    expect(rows.length).toBe(7);
    for (const r of rows) {
      expect(r.tochigiName).toMatch(/ダム$/);
      expect(r.observedAt).toBeInstanceOf(Date);
    }
  });

  test('extracts 寺山ダム values (waterStorage 千m³ → m³)', async () => {
    const rows = parseTochigiCsv(await readFile(FIXTURE, 'utf8'));
    const terayama = rows.find((r) => r.tochigiName === '寺山ダム');
    expect(terayama).toBeDefined();
    expect(terayama?.waterLevelM).toBeCloseTo(394.46, 2);
    // 981.4 千m³ → 981,400 m³.
    expect(terayama?.storageVolumeM3).toBe(981_400);
    expect(terayama?.inflowM3s).toBeCloseTo(0.11, 3);
    expect(terayama?.outflowM3s).toBeCloseTo(0.44, 3);
    // dateObserved is already UTC ISO — pass through.
    expect(terayama?.observedAt.toISOString()).toBe('2026-05-27T15:50:00.000Z');
  });

  test('parses storage=0 (中禅寺ダム headworks shows zero stored volume)', async () => {
    const rows = parseTochigiCsv(await readFile(FIXTURE, 'utf8'));
    const chuzenji = rows.find((r) => r.tochigiName === '中禅寺ダム');
    expect(chuzenji?.storageVolumeM3).toBe(0);
  });

  test('returns empty array for header-only / empty input', () => {
    expect(parseTochigiCsv('"id","type","pointName"\n')).toEqual([]);
    expect(parseTochigiCsv('')).toEqual([]);
  });
});

describe('chooseMaster (#79)', () => {
  // 中禅寺 has a （元） (NDI 633) and a （再） (NDI 634) master row; both carry
  // completed_year 1998 in the dam master.
  const masters = [
    { id: 9314n, name: '中禅寺（元）', completedYear: 1998, stamp: null },
    { id: 9315n, name: '中禅寺（再）', completedYear: 1998, stamp: null },
    { id: 9295n, name: '寺山', completedYear: 1984, stamp: null },
  ];

  test('binds an unstamped 中禅寺ダム to the completed （再）, not the lower-id （元）', () => {
    expect(chooseMaster('中禅寺', masters, '中禅寺ダム')).toBe(9315n);
  });

  test('keeps the row already stamped with the station', () => {
    const stamped = masters.map((m) => (m.id === 9314n ? { ...m, stamp: '中禅寺ダム' } : m));
    expect(chooseMaster('中禅寺', stamped, '中禅寺ダム')).toBe(9314n);
  });
});
