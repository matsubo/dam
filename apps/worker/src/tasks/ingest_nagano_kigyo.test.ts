// apps/worker/src/tasks/ingest_nagano_kigyo.test.ts
//
// Fixtures are verbatim captures of 長野県企業局 ダム情報's 10分諸量 JSON
// (naganoken-kigyokyoku.jp/json/{takato,sugadaira}_new.json) taken
// 2026-09-27 21:42 JST. Both files were served with
// `Last-Modified: Sun, 27 Sep 2026 12:40:33 GMT` and hold the four newest
// 10-minute rows, newest first, stamped "HH:MM" with no date.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DAMS, parseNaganoKigyoTable } from './ingest_nagano_kigyo.ts';

const DIR = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/nagano_kigyo');
const LAST_MODIFIED = new Date('2026-09-27T12:40:33Z');

async function fixture(file: string): Promise<string> {
  return readFile(join(DIR, file), 'utf8');
}

function dam(name: string): (typeof DAMS)[number] {
  const cfg = DAMS.find((d) => d.name === name);
  if (!cfg) throw new Error(`no config for ${name}`);
  return cfg;
}

describe('parseNaganoKigyoTable', () => {
  test('dates every row from Last-Modified, newest first', async () => {
    const rows = parseNaganoKigyoTable(
      await fixture('sugadaira_new_2026-09-27.json'),
      dam('菅平ダム'),
      LAST_MODIFIED,
    );
    expect(rows.map((r) => r.observedAt.toISOString())).toEqual([
      '2026-09-27T12:40:00.000Z',
      '2026-09-27T12:30:00.000Z',
      '2026-09-27T12:20:00.000Z',
      '2026-09-27T12:10:00.000Z',
    ]);
  });

  test('reads 菅平 EL level, total flows and 貯水率 as a fraction', async () => {
    const [latest] = parseNaganoKigyoTable(
      await fixture('sugadaira_new_2026-09-27.json'),
      dam('菅平ダム'),
      LAST_MODIFIED,
    );
    // v_reservoirlevel13 is EL (常時満水位 EL 1139.5 m); v_reservoirlevel7 is
    // the 15.31 m gauge height and must not be taken.
    expect(latest?.waterLevelM).toBe(1131.31);
    expect(latest?.inflowM3s).toBe(1.04);
    expect(latest?.outflowM3s).toBe(1.42);
    expect(latest?.storageRate).toBeCloseTo(0.453, 6);
  });

  test('reads 高遠 EL level and flows; it publishes no rate', async () => {
    const [latest] = parseNaganoKigyoTable(
      await fixture('takato_new_2026-09-27.json'),
      dam('高遠ダム'),
      LAST_MODIFIED,
    );
    expect(latest?.waterLevelM).toBe(753.75);
    expect(latest?.inflowM3s).toBe(16.29);
    expect(latest?.outflowM3s).toBe(20.09);
    expect(latest?.storageRate).toBeNull();
  });

  test('rolls back a day when the rows cross midnight', async () => {
    const json = (await fixture('takato_new_2026-09-27.json'))
      .replace('"21:40"', '"00:00"')
      .replace('"21:30"', '"23:50"')
      .replace('"21:20"', '"23:40"')
      .replace('"21:10"', '"23:30"');
    const rows = parseNaganoKigyoTable(json, dam('高遠ダム'), new Date('2026-09-27T15:00:40Z'));
    expect(rows.map((r) => r.observedAt.toISOString())).toEqual([
      '2026-09-27T15:00:00.000Z',
      '2026-09-27T14:50:00.000Z',
      '2026-09-27T14:40:00.000Z',
      '2026-09-27T14:30:00.000Z',
    ]);
  });

  test('a newest row later than Last-Modified belongs to the previous day', async () => {
    // File written at 00:00:10 JST but its newest row says 23:50: the row is
    // yesterday's, never 23:50 later today.
    const json = (await fixture('takato_new_2026-09-27.json')).replace('"21:40"', '"23:50"');
    const [latest] = parseNaganoKigyoTable(json, dam('高遠ダム'), new Date('2026-09-27T15:00:10Z'));
    expect(latest?.observedAt.toISOString()).toBe('2026-09-27T14:50:00.000Z');
  });

  test('欠測 and 未実装 markers read as null', async () => {
    const json = (await fixture('sugadaira_new_2026-09-27.json'))
      .replace('"v_reservoirlevel13": "1131.31"', '"v_reservoirlevel13": "欠測"')
      .replace('"v_totalinflow11": "1.04"', '"v_totalinflow11": "未実装"');
    const [latest] = parseNaganoKigyoTable(json, dam('菅平ダム'), LAST_MODIFIED);
    expect(latest?.waterLevelM).toBeNull();
    expect(latest?.inflowM3s).toBeNull();
    expect(latest?.outflowM3s).toBe(1.42);
  });
});
