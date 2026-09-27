// apps/worker/src/tasks/ingest_jwa_toyokawa.test.ts
//
// Fixture is a verbatim UTF-8 capture of 水資源機構 中部支社 リアルタイム情報
// 豊川水系 (water.go.jp/mizu/chubu/realtime/index_2.html) taken 2026-09-28
// 07:16 JST, 観測時刻 2026年09月28日 07時10分:
//   宇連ダム 貯水位 219.19 EL.m, 有効貯水量 18158 10³m³, 流入量 2.17 m³/s,
//            放流量（利水） 0.00 m³/s
//   大島ダム 貯水位 232.65 EL.m, 有効貯水量  7579 10³m³, 流入量 1.30 m³/s,
//            放流量（利水） 0.00 m³/s
// The unit sits in markup right after the value
// (`18158<span class="unit">10<sup>3</sup>m<sup>3</sup></span>`), and the
// page prints no total-outflow figure — only 放流量（利水）.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTokyokawaTimestamp, parseToyokawaHtml } from './ingest_jwa_toyokawa.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa_toyokawa/index_2_2026-09-28.html',
);

async function fixtureHtml(): Promise<string> {
  return readFile(FIXTURE, 'utf8');
}

describe('parseTokyokawaTimestamp', () => {
  test('parses JST timestamp to UTC (subtract 9h)', () => {
    const d = parseTokyokawaTimestamp('観測時刻：2026年06月05日 09時40分');
    expect(d?.toISOString()).toBe('2026-06-05T00:40:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 wraps to previous UTC day)', () => {
    const d = parseTokyokawaTimestamp('観測時刻：2026年06月05日 08時00分');
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null when no timestamp present', () => {
    expect(parseTokyokawaTimestamp('no timestamp here')).toBeNull();
  });
});

describe('parseToyokawaHtml', () => {
  test('reads both dams at the page 観測時刻, 10³m³ volume as m³, no outflow', async () => {
    const { observedAt, rows } = parseToyokawaHtml(await fixtureHtml());
    expect(observedAt?.toISOString()).toBe('2026-09-27T22:10:00.000Z');
    // Not 18,158,103 / 7,579,103: the 10<sup>3</sup> of the unit is not a digit
    // of the value. 放流量（利水） is the water-supply release only, so no
    // outflow is read.
    expect(rows).toEqual([
      { toyoName: '宇連ダム', waterLevelM: 219.19, storageVolumeM3: 18_158_000, inflowM3s: 2.17 },
      { toyoName: '大島ダム', waterLevelM: 232.65, storageVolumeM3: 7_579_000, inflowM3s: 1.3 },
    ]);
  });

  test('a "cc" (communication cut) cell is null, not the 10³ or m³ of the unit', async () => {
    const html = (await fixtureHtml()).replace('>18158<', '>cc<').replace('>2.17<', '>cc<');
    const uren = parseToyokawaHtml(html).rows.find((r) => r.toyoName === '宇連ダム');
    expect(uren).toEqual({
      toyoName: '宇連ダム',
      waterLevelM: 219.19,
      storageVolumeM3: null,
      inflowM3s: null,
    });
  });

  test('skips a dam whose level and volume are both cut, keeps the other', async () => {
    const html = (await fixtureHtml()).replace('>219.19<', '>cc<').replace('>18158<', '>cc<');
    const { rows } = parseToyokawaHtml(html);
    expect(rows.map((r) => r.toyoName)).toEqual(['大島ダム']);
  });
});
