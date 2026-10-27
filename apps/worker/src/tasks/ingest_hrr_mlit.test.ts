// apps/worker/src/tasks/ingest_hrr_mlit.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim capture of www.hrr.mlit.go.jp/river/dam-bousai/data/tmDam.txt
// taken 2026-10-27 (00:30 JST rows; 大町 at 00:20).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Reading } from '../ingest/types.ts';
import { hrrEntries } from './ingest_hrr_mlit.ts';

const FIXTURE = join(
  import.meta.dir,
  '../../../../tests/fixtures/hrr_mlit/tmDam_2026-10-27T0030.txt',
);

function readingOf(e: Entry | undefined): Reading {
  if (!e || typeof e.reading === 'function') throw new Error('expected a static reading');
  return e.reading;
}

describe('hrrEntries', () => {
  test('every row of the file is an entry keyed by its name, blank lines skipped', async () => {
    const entries = hrrEntries(await readFile(FIXTURE, 'utf8'));
    expect(entries.map((e) => e.key)).toEqual([
      '大川ダム',
      '大石ダム',
      '横川ダム',
      '三国川ダム',
      '大町ダム',
      '宇奈月ダム',
      '手取川ダム',
    ]);
    expect(entries.find((e) => e.key === '手取川ダム')?.pref).toBe('17');
    expect(entries.every((e) => readingOf(e).state === 'values')).toBe(true);
  });

  test('reads 大川ダム: flows, level, JST time and coordinates', async () => {
    const okawa = hrrEntries(await readFile(FIXTURE, 'utf8')).find((e) => e.key === '大川ダム');
    expect(okawa?.pref).toBe('07');
    expect(okawa?.lat).toBeCloseTo(37.3464, 4);
    expect(okawa?.lng).toBeCloseTo(139.9119, 4);
    expect(readingOf(okawa)).toEqual({
      state: 'values',
      observations: [
        {
          observedAt: new Date('2026-10-26T15:30:00.000Z'),
          inflowM3s: 12.41,
          outflowM3s: 12.47,
          waterLevelM: 374.38,
        },
      ],
    });
  });

  test('a row the configuration does not know is listed with no prefecture', () => {
    const [e] = hrrEntries(
      '新ダム,21599,00001,37.0,139.0,2026/10/27,00:30,1.00,2.00,300.00,-,-,1,0',
    );
    expect(e?.key).toBe('新ダム');
    expect(e?.pref).toBeNull();
  });

  test('"-" in every value column is provider-marked empty; a bad date is unreadable', () => {
    const [marked, undated] = hrrEntries(
      [
        '大川ダム,21527,00001,37.3,139.9,2026/10/27,00:30,-,-,-,-,-,1,0',
        '大石ダム,21528,00001,38.0,139.5,,,7.09,3.52,170.75,-,-,15,0',
      ].join('\n'),
    );
    expect(readingOf(marked).state).toBe('empty');
    expect(readingOf(undated).state).toBe('unreadable');
  });
});
