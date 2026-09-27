// apps/worker/src/tasks/ingest_kochi_kigyo.test.ts
//
// Fixture is a verbatim UTF-8 capture of 高知県公営企業局 発電所集中監視制御Webシステム
// ダム水文量表 (http://210.155.220.59/web/crt17/01/01, default 本日 / 1時間 view)
// taken 2026-09-27 21:47 JST: 48 hourly rows, 2026-09-25 22:00 … 2026-09-27
// 21:00 JST, each with 貯水位 / 流入量 / 放流量 / 雨量 / 累計雨量 for 吉野ダム
// then 杉田ダム.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseMaster, parseKochiKigyoTable } from './ingest_kochi_kigyo.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/kochi_kigyo/dam_suimon_2026-09-27.html',
);

async function fixtureHtml(): Promise<string> {
  return readFile(FIXTURE, 'utf8');
}

describe('parseKochiKigyoTable', () => {
  test('lists both dams the table publishes', async () => {
    const { dams } = parseKochiKigyoTable(await fixtureHtml());
    expect(dams).toEqual(['吉野ダム', '杉田ダム']);
  });

  test('reads every hourly row for each dam, JST converted to UTC', async () => {
    const { readings } = parseKochiKigyoTable(await fixtureHtml());
    const sugita = readings.filter((r) => r.name === '杉田ダム');
    expect(sugita).toHaveLength(48);
    expect(sugita[0]?.observedAt.toISOString()).toBe('2026-09-25T13:00:00.000Z');
    expect(sugita[47]?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
  });

  test('takes each dam its own 貯水位 / 流入量 / 放流量 columns', async () => {
    const latest = parseKochiKigyoTable(await fixtureHtml()).readings.filter(
      (r) => r.observedAt.toISOString() === '2026-09-27T12:00:00.000Z',
    );
    expect(latest.find((r) => r.name === '吉野ダム')).toMatchObject({
      waterLevelM: 97.15,
      inflowM3s: 19.4,
      outflowM3s: 19.3,
    });
    expect(latest.find((r) => r.name === '杉田ダム')).toMatchObject({
      waterLevelM: 76.82,
      inflowM3s: 28.1,
      outflowM3s: 21.6,
    });
  });

  test('stores the hourly 雨量, not the 累計雨量 beside it', async () => {
    // 2026-09-26 00:00 JST: 杉田 hourly 1.5 mm; by 21:00 the next day the
    // 累計 column reads 59.5 while that hour's rainfall is 0.0.
    const { readings } = parseKochiKigyoTable(await fixtureHtml());
    const sugita = readings.filter((r) => r.name === '杉田ダム');
    expect(
      sugita.find((r) => r.observedAt.toISOString() === '2026-09-25T15:00:00.000Z')?.rainfallMm,
    ).toBe(1.5);
    expect(sugita[47]?.rainfallMm).toBe(0);
  });

  test('reads a blank or non-numeric cell as null and keeps the row', async () => {
    const html = (await fixtureHtml()).replace(
      /(2026-09-27 21:00:00\.0<\/td>\s*<td class="info">)97\.15/,
      '$1欠測',
    );
    const yoshino = parseKochiKigyoTable(html).readings.find(
      (r) => r.name === '吉野ダム' && r.observedAt.toISOString() === '2026-09-27T12:00:00.000Z',
    );
    expect(yoshino?.waterLevelM).toBeNull();
    expect(yoshino?.inflowM3s).toBe(19.4);
  });
});

describe('chooseMaster', () => {
  const m = (id: number, name: string, stamp: string | null = null) => ({
    id: BigInt(id),
    name,
    completedYear: null,
    stamp,
  });

  // Real pref-39 rows: 吉野 (NDI 2096, 高知県公営企業局) and the unrelated
  // agricultural 吉野溜池 (NDI 2085), which shares the 吉野 prefix.
  test('binds 吉野ダム to 吉野, not the lower-id 吉野溜池', () => {
    const masters = [m(10369, '吉野'), m(10370, '杉田'), m(10398, '吉野溜池')];
    expect(chooseMaster('吉野ダム', masters)).toBe(10369n);
    expect(chooseMaster('杉田ダム', masters)).toBe(10370n);
  });

  test('leaves a station unbound rather than fall back to a prefix hit', () => {
    expect(chooseMaster('吉野ダム', [m(10398, '吉野溜池')])).toBeNull();
  });

  test('keeps the row already stamped with the station', () => {
    const masters = [m(10, '杉田'), m(20, '杉田', '杉田ダム')];
    expect(chooseMaster('杉田ダム', masters)).toBe(20n);
  });
});
