// apps/worker/src/tasks/ingest_hyogo.test.ts
//
// Pure-function tests for the 兵庫県 BODIK open-data CSV parser. The CSV
// (CC-BY 4.0, 10-min refresh) is exposed at a stable URL on data.bodik.jp.
// Fixture is a verbatim capture from 2026-05-26.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHyogoCsv } from './ingest_hyogo.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/hyogo/tm-dam_2026-05-26.csv',
);

describe('parseHyogoCsv', () => {
  test('parses one row per dam with units converted', async () => {
    const rows = parseHyogoCsv(await readFile(FIXTURE, 'utf8'));
    // 22 data rows in the fixture (incl. 分水堰 weir).
    expect(rows.length).toBe(22);
  });

  test('extracts 青野ダム values (貯水量 千m³ → m³)', async () => {
    const rows = parseHyogoCsv(await readFile(FIXTURE, 'utf8'));
    const aono = rows.find((r) => r.hyogoName === '青野ダム');
    expect(aono).toBeDefined();
    expect(aono?.waterLevelM).toBeCloseTo(180.81, 2);
    // 8706 千m³ → 8,706,000 m³.
    expect(aono?.storageVolumeM3).toBe(8_706_000);
    expect(aono?.inflowM3s).toBeCloseTo(0.27, 3);
    expect(aono?.outflowM3s).toBeCloseTo(0.95, 3);
    // 2026/05/26 13:10 JST = 04:10 UTC.
    expect(aono?.observedAt.toISOString()).toBe('2026-05-26T04:10:00.000Z');
  });

  test('nulls a value whose flag is non-zero (但東ダム 貯水量 flag=160)', async () => {
    const rows = parseHyogoCsv(await readFile(FIXTURE, 'utf8'));
    const tanto = rows.find((r) => r.hyogoName === '但東ダム');
    expect(tanto).toBeDefined();
    expect(tanto?.storageVolumeM3).toBeNull();
    // its other (flag=0) fields still come through.
    expect(tanto?.inflowM3s).toBeCloseTo(0.026, 3);
  });

  test('returns empty array for header-only / empty input', () => {
    expect(parseHyogoCsv('局番号,観測所名,観測時刻\n')).toEqual([]);
    expect(parseHyogoCsv('')).toEqual([]);
  });
});
