// apps/worker/src/tasks/ingest_ktr_kinu.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim capture of www.ktr.mlit.go.jp/kinudamu/daminfo/jp/realDM.html
// taken 2026-10-27 (KansokuT 00:40 JST for all four dams). 湯西川's 発電使用水量
// item carries validFlag 0.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Reading } from '../ingest/types.ts';
import { kinuEntries, kinuReadings, parseKinuTimestamp } from './ingest_ktr_kinu.ts';

const FIXTURE = join(
  import.meta.dir,
  '../../../../tests/fixtures/ktr_kinu/realDM_2026-10-27T0040.html',
);
const page = () => readFile(FIXTURE, 'utf8');

function readingOf(e: Entry | undefined): Reading {
  if (!e || typeof e.reading === 'function') throw new Error('expected a static reading');
  return e.reading;
}

describe('parseKinuTimestamp', () => {
  test('parses "YYYY-MM-DD-HH-MM" JST → UTC', () => {
    expect(parseKinuTimestamp('2026-05-18-14-50')?.toISOString()).toBe('2026-05-18T05:50:00.000Z');
  });

  test('returns null on malformed input', () => {
    expect(parseKinuTimestamp('bad')).toBeNull();
  });
});

describe('kinuEntries', () => {
  test('lists the four dams by DamTbl slug in 栃木', async () => {
    const entries = kinuEntries({ html: await page() });
    expect(entries.map((e) => [e.key, e.name])).toEqual([
      ['ikari', '五十里ダム'],
      ['kawamata', '川俣ダム'],
      ['kawaji', '川治ダム'],
      ['yunishigawa', '湯西川ダム'],
    ]);
    expect(entries.every((e) => e.pref === '09')).toBe(true);
  });

  test('reads 五十里: level, inflow, 全放流量 and 累加雨量 at the JST 観測時刻', async () => {
    expect(readingOf(kinuEntries({ html: await page() })[0])).toEqual({
      state: 'values',
      observations: [
        {
          observedAt: new Date('2026-10-26T15:40:00.000Z'),
          waterLevelM: 577.02,
          inflowM3s: 2.49,
          outflowM3s: 1.99,
          rainfallMm: 18.5,
        },
      ],
    });
  });

  test('takes 全放流量 (item 4), not ダム放流量 (item 3), for 川治', async () => {
    const r = readingOf(kinuEntries({ html: await page() })[2]);
    if (r.state !== 'values') throw new Error(r.state);
    expect(r.observations[0]?.outflowM3s).toBe(0.49);
  });

  test('validFlag 0 on every stored item is provider-marked empty', () => {
    const marked =
      "[[0,0,'',1,0,1],[0,0,'',1,0,1],[1,-50,'-0.50',1,0,1],[0,0,'',1,0,1],[0,0,'',1,0,1],[0,0,'',1,0,1],[0,0,'',1,0,1]]";
    const valued =
      "[[1,57702,'577.02',1,0,1],[1,249,'2.49',1,0,1],[1,-50,'-0.50',1,0,1],[1,199,'1.99',1,0,1],[1,199,'1.99',1,0,1],[1,0,'0.00',1,0,1],[1,185,'18.5',1,0,1]]";
    const html = `KansokuT = [${"'2026-10-27-00-40',".repeat(4)}];
DamVal = [
${marked},
${valued},
${valued},
${valued}
];`;
    expect(kinuReadings(html).map((r) => r.state)).toEqual(['empty', 'values', 'values', 'values']);
  });

  test('a failed fetch or a page without DamVal leaves all four unreadable, still listed', () => {
    for (const p of [{ error: 'HTTP 503' }, { html: '<html>メンテナンス中</html>' }]) {
      const entries = kinuEntries(p);
      expect(entries).toHaveLength(4);
      expect(entries.every((e) => readingOf(e).state === 'unreadable')).toBe(true);
    }
  });

  test('kinuReadings returns one reading per dam in page order', async () => {
    expect((await page().then(kinuReadings)).map((r) => r.state)).toEqual([
      'values',
      'values',
      'values',
      'values',
    ]);
  });
});
