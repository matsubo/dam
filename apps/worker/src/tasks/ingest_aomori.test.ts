// apps/worker/src/tasks/ingest_aomori.test.ts
//
// Pure-function tests for the 青森県河川砂防情報提供システム ダム諸量グラフ
// (10分) parser. Fixtures are verbatim Shift_JIS captures of
// servletBousaiContents?style=dam_graph10m&dk=4&it=0&sn=N taken 2026-09-27:
//   sn=1  下湯ダム         nw=1 (16:40 row not yet received)
//   sn=7  遠部ダム         nw=1 (利水 column "---": 治水 + 不特定 only)
//   sn=41 津軽ダム(国)     nw=1 (有効 rate "---", 利水 rate present)
//   sn=2  浅虫ダム         tm=2026-09-27 01:00 (window crosses midnight)
// and of the ダム諸量現況表 that lists every dam with its 局番号
// (servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1, 21:40 JST).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAomoriDamGraph, parseAomoriDamList } from './ingest_aomori.ts';

const FIXTURE_DIR = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/aomori');

async function fixtureHtml(name: string): Promise<string> {
  const buf = await readFile(join(FIXTURE_DIR, name));
  return new TextDecoder('shift_jis').decode(buf);
}

describe('parseAomoriDamList', () => {
  test('enumerates all 11 published dams with their 局番号, (国) dropped from the name', async () => {
    const dams = parseAomoriDamList(await fixtureHtml('dam_table_status_2026-09-27.shiftjis.html'));
    expect(dams).toEqual([
      { aomoriName: '下湯ダム', stationNo: 1 },
      { aomoriName: '久吉ダム', stationNo: 6 },
      { aomoriName: '浅瀬石川ダム', stationNo: 40 },
      { aomoriName: '世増ダム', stationNo: 11 },
      { aomoriName: '浅虫ダム', stationNo: 2 },
      { aomoriName: '遠部ダム', stationNo: 7 },
      { aomoriName: '津軽ダム', stationNo: 41 },
      { aomoriName: '飯詰ダム', stationNo: 16 },
      { aomoriName: '小泊ダム', stationNo: 17 },
      { aomoriName: '清水目ダム', stationNo: 26 },
      { aomoriName: '川内ダム', stationNo: 31 },
    ]);
  });
});

describe('parseAomoriDamGraph', () => {
  test('下湯: latest received row, 利水 rate preferred over 有効', async () => {
    const rows = parseAomoriDamGraph(
      await fixtureHtml('dam_graph10m_sn1_2026-09-27.shiftjis.html'),
    );
    const latest = rows.at(-1);
    // The 16:40 row is blank (未受信), so the latest observation is 16:30 JST.
    expect(latest?.observedAt.toISOString()).toBe('2026-09-27T07:30:00.000Z');
    expect(latest?.waterLevelM).toBeCloseTo(263.43, 2);
    expect(latest?.inflowM3s).toBeCloseTo(1.2, 2);
    expect(latest?.outflowM3s).toBeCloseTo(1.2, 2);
    // 貯水量(有効容量) is printed in 1000 m³.
    expect(latest?.storageVolumeM3).toBe(2_111_000);
    // 貯水率(利水容量) 100.00 %, not 貯水率(有効容量) 19.20 %.
    expect(latest?.storageRate).toBeCloseTo(1.0, 4);
  });

  test('遠部: 利水 column blank ("---") falls back to the 有効 rate', async () => {
    const rows = parseAomoriDamGraph(
      await fixtureHtml('dam_graph10m_sn7_2026-09-27.shiftjis.html'),
    );
    const latest = rows.at(-1);
    // 16:40 carries dam values with the rain cells still empty — positions
    // must not shift.
    expect(latest?.observedAt.toISOString()).toBe('2026-09-27T07:40:00.000Z');
    expect(latest?.waterLevelM).toBeCloseTo(214.94, 2);
    expect(latest?.inflowM3s).toBeCloseTo(0.13, 2);
    expect(latest?.storageVolumeM3).toBe(0);
    expect(latest?.storageRate).toBe(0);
  });

  test('津軽(国): 有効 rate blank, 利水 rate used', async () => {
    const rows = parseAomoriDamGraph(
      await fixtureHtml('dam_graph10m_sn41_2026-09-27.shiftjis.html'),
    );
    const latest = rows.at(-1);
    expect(latest?.observedAt.toISOString()).toBe('2026-09-27T07:30:00.000Z');
    expect(latest?.waterLevelM).toBeCloseTo(195.05, 2);
    expect(latest?.storageVolumeM3).toBe(42_561_000);
    expect(latest?.storageRate).toBeCloseTo(0.578, 4);
  });

  test('rows before midnight take the previous day (header is the window end date)', async () => {
    const rows = parseAomoriDamGraph(
      await fixtureHtml('dam_graph10m_sn2_2026-09-27-0100.shiftjis.html'),
    );
    expect(rows).toHaveLength(24);
    // 21:10 JST 2026-09-26 … 01:00 JST 2026-09-27.
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-09-26T12:10:00.000Z');
    const at2350 = rows.find((r) => r.observedAt.toISOString() === '2026-09-26T14:50:00.000Z');
    const at0000 = rows.find((r) => r.observedAt.toISOString() === '2026-09-26T15:00:00.000Z');
    expect(at2350).toBeDefined();
    expect(at0000).toBeDefined();
    expect(rows.at(-1)?.observedAt.toISOString()).toBe('2026-09-26T16:00:00.000Z');
    // 浅虫: 利水 97.27 % against 有効 63.00 %.
    expect(rows.at(-1)?.storageRate).toBeCloseTo(0.9727, 4);
    expect(rows.at(-1)?.storageVolumeM3).toBe(107_000);
  });

  test('refuses a page whose rate columns are not in the expected order', async () => {
    const html = (await fixtureHtml('dam_graph10m_sn1_2026-09-27.shiftjis.html'))
      .replace('貯水率<br>(利水容量)', '貯水率<br>(TMP)')
      .replace('貯水率<br>(有効容量)', '貯水率<br>(利水容量)')
      .replace('貯水率<br>(TMP)', '貯水率<br>(有効容量)');
    expect(parseAomoriDamGraph(html)).toEqual([]);
  });
});
