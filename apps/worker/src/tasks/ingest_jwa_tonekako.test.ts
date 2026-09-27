// apps/worker/src/tasks/ingest_jwa_tonekako.test.ts
//
// Fixtures are verbatim captures (2026-09-27 21:45 JST) of the two hourly
// tables behind 利根河口堰 情報提供 (tonekako.sakura.ne.jp), both stamped
// NewTime 2026/09/27 21:00:
//   suii   json/online/J225360003.js — 正時水位表 (Y.P.m): 銚子 -1.0km |
//          新田 18.0km | 新宿 19.0km | 阿玉川 26.0km | 操作タイプ | 黒部川 ×3
//   ryuryo json/online/J225460003.js — 正時流量表: 堰流入量 | 堰通過流量 |
//          順流総量 | 逆流総量 | 操作タイプ | 霞ヶ浦導送水 | 黒部川 ×2
// The page labels each row NewTime − (23 − i) hours; the JSON carries no
// per-row time.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseHourlyTable, tonekakoHours } from './ingest_jwa_tonekako.ts';

const DIR = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/jwa_tonekako');

const suii = (): Promise<string> => readFile(join(DIR, 'suii_hourly_2026-09-27T2100.js'), 'utf8');
const ryuryo = (): Promise<string> =>
  readFile(join(DIR, 'ryuryo_hourly_2026-09-27T2100.js'), 'utf8');

describe('parseHourlyTable', () => {
  test('labels 24 rows back from NewTime, JST → UTC', async () => {
    const t = parseHourlyTable(await suii());
    expect(t?.observedAt).toHaveLength(24);
    expect(t?.observedAt[0]?.toISOString()).toBe('2026-09-26T13:00:00.000Z'); // 09/26 22:00
    expect(t?.observedAt[23]?.toISOString()).toBe('2026-09-27T12:00:00.000Z'); // 09/27 21:00
    expect(t?.columns).toHaveLength(8);
  });

  test('reads ** (no value) as null, not zero', async () => {
    const t = parseHourlyTable(await ryuryo());
    expect(t?.columns[0]?.[23]).toBe(848.2);
    expect(t?.columns[1]?.every((v) => v === null)).toBe(true);
  });

  test('rejects a body without NewTime', () => {
    expect(parseHourlyTable('JsonData = eval({})')).toBeNull();
  });
});

describe('tonekakoHours', () => {
  test('takes 堰上流 level from 新宿 19.0km and 堰流入量 as inflow', async () => {
    const hours = tonekakoHours(await suii(), await ryuryo());
    expect(hours).toHaveLength(24);
    const last = hours.at(-1);
    expect(last?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    // 新田 18.0km (堰下流) reads 1.39 and 阿玉川 26.0km 1.52 at the same hour.
    expect(last?.waterLevelM).toBe(1.41);
    expect(last?.inflowM3s).toBe(848.2);
    // 堰通過流量 prints ** while the gates are open (操作タイプ 5).
    expect(last?.outflowM3s).toBeNull();
    const first = hours[0];
    expect(first?.waterLevelM).toBe(1.37);
    expect(first?.inflowM3s).toBe(988.08);
  });

  test('keeps only hours both tables carry when a fetch straddles an update', async () => {
    // upsertObservations overwrites every column, so an hour present in one
    // table only would null the other table's values stored an hour earlier.
    const newer = (await ryuryo()).replace('2026\\/09\\/27 21:00:00', '2026\\/09\\/27 22:00:00');
    const hours = tonekakoHours(await suii(), newer);
    expect(hours).toHaveLength(23);
    // 09/26 22:00 is only in the older 水位表 and 09/27 22:00 only in the newer
    // 流量表: neither is emitted.
    expect(hours[0]?.observedAt.toISOString()).toBe('2026-09-26T14:00:00.000Z');
    expect(hours.at(-1)?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(hours.every((h) => h.waterLevelM !== null && h.inflowM3s !== null)).toBe(true);
    // Each hour pairs the rows labelled with that hour, not the same index.
    expect(hours[0]?.waterLevelM).toBe(1.35); // 水位表 row 2 (09/26 23:00)
    expect(hours[0]?.inflowM3s).toBe(988.08); // newer 流量表 row 1 (09/26 23:00)
    expect(hours.at(-1)?.waterLevelM).toBe(1.41);
    expect(hours.at(-1)?.inflowM3s).toBe(864.83);
  });

  test('stores nothing when a table no longer has the 8-column layout', async () => {
    // A column added or dropped upstream would shift 新宿 onto a neighbour.
    const src = await suii();
    const start = src.indexOf('[', src.indexOf("'HyoAll'"));
    const end = src.lastIndexOf(']') + 1;
    const hyo = JSON.parse(src.slice(start, end));
    hyo[0].ColumnList.shift();
    const shifted = src.slice(0, start) + JSON.stringify(hyo) + src.slice(end);
    expect(tonekakoHours(shifted, await ryuryo())).toEqual([]);
  });
});
